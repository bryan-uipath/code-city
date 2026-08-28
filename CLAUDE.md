# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A 3D "code city" visualizer for TS/JS repos: `analyzer/` mines a target repo into
one `data.json`, `viewer/` renders it with Three.js. Two halves, one contract
(`shared/types.ts`). No test suite — verification is `npm run typecheck`, the
motion probe, and looking at the city.

## Commands

```bash
npm run analyze -- /path/to/repo            # -> viewer/public/data.json (analyzes the whole repo by default)
npm run analyze -- /path/to/repo --roots src,lib --out other.json --no-prs
npm run analyze -- .                        # required before the bundled welcome tour works
npm run dev                                 # vite dev server (source/diff/status/search API live)
npm run typecheck                           # tsc --noEmit — the only fast whole-repo check
npm run build / npm run export              # bundle / static self-contained bundle with data.json baked in
npm run hero                                # regenerate docs/hero.png (needs `npx playwright install chromium`)
node scripts/motion-probe.mjs               # camera-motion regression harness; needs `npm run dev -- --port 5311` first (runs headed on purpose)
```

`viewer/public/data.json` and the analyzer cache (`.codecity/`, keyed by sha1 of
the analyzed repo root, kept in THIS project — never inside the analyzed repo)
are gitignored. Re-running the analyzer overwrites whatever repo you were
looking at.

## Architecture

**`shared/types.ts` is the contract.** The analyzer produces it, the viewer
consumes it; change it and both sides move. `Commit.f` indexes into the `files`
table, `Commit.d` carries per-file `[adds, dels]` — the strata massing
reconstructs LOC-at-commit from those deltas client-side.

**`shared/host.ts` — the `CityHost` seam.** The viewer never fetches anything
itself; it asks the host. `HttpHost` (data.json + the vite dev API) is the only
implementation today, and a VS Code webview host is the intended second one, so
keep new outside-world access behind this interface. Every git-backed endpoint is
optional: a non-JSON response latches the host unavailable and callers hide their
sections — that is what makes the static export work.

**`viewer/vite.config.js` is the dev API** (`/api/source|log|diff|status|search`),
dev-server only. It shells out to `git -C <data.repo.root>`; paths go through
`safeRelPath` (no absolute, no `..`, must resolve under root and exist) and
hashes through `HASH_RE`. Keep that discipline on any new route.

**`viewer/src/main.ts` owns state; every other viewer module owns one thing.**
It is large and sectioned by banner comments (State / Scene / HUD / Overlays /
Strata / Search / Tour / Working tree / Coupling / PRs / Selection & focus /
Labels / Interaction) — find the section before adding. `city.ts` is the only
place that builds Three.js geometry; `vtree.ts` declares every field the viewer
augments onto the read-only data.json tree (parent links, rects, synthetic
file/module scopes).

**The focus stack.** The city renders exactly one scope. Double-click disposes
the current city and re-lays out that subtree at full extent
(folder → file → module → member), with synthetic nodes for the file/module
levels. PR markers, arcs, labels and scaffolding are all rebuilt against the
scope — nothing may assume the real tree root.

**Strata is the shared massing, not a mode.** When a commit stream exists and
the scope root is a real folder, a file *is* its stack of per-commit slabs in
every mode; modes only recolor. Never make a mode change the geometry — the
whole point is that switching overlays doesn't reshuffle the skyline.

**Camera motion is a designed system, not tuning constants.** Stage homing so
the world never teleports, camera moved in bearing/pitch/distance rather than
Cartesian space, route straightening, arc length measured in *apparent* motion,
crane exponent solved by bisection against the skyline. Read the "Camera motion"
section of DESIGN.md before touching flights, and validate with the motion probe.

## Conventions

- Every source file opens with a `/** … */` header explaining its role; match it.
- Layout convention: city on the XZ plane, Y up; a rect is `{x, z, w, h}` with
  `(x, z)` the min corner.
- Never allocate inside the render loop — main.ts keeps scratch objects, labels
  and terrace signs re-pick on lazy timers (~150–200ms), not per frame.
- Everything data-derived that reaches `innerHTML` is escaped (`escapeHtml` /
  `markHtml` in `sidebar.ts`).
- Tour JSON is untrusted input: it only enters through `validateTour` in
  `shared/tour.ts`, narration renders as plain text, artifact URLs are
  scheme-checked, and `?tour=` accepts only relative same-origin `.json`.
- tsconfig is strict with `noUncheckedIndexedAccess`; imports use explicit
  `.js` extensions.

## Reference docs

- `DESIGN.md` — the metaphor, full data contract, style guide, and a per-feature
  record of what is implemented and why (strata filter, terraces, camera motion,
  analyzer cache, future ideas). The design rationale lives here, not in commit
  messages.
- `docs/tours.md` — the tour schema and the recipe for an agent emitting a tour
  from a PR diff.
