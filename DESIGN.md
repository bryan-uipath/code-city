# Codebase Visualizer — Design

A 3D "code city" built with Three.js, rendered in a retro-futuristic hologram style
(future-dark: deep navy, glowing cyan/violet, UiPath orange accents — same visual
family as the flow-presentation tool).

**Vibe inspirations**: *Hackers* (1995) — flying through the Gibson's glowing
towers of data — and *Jurassic Park*'s "It's a Unix system! I know this!"
(the real SGI **FSN** 3D file navigator on screen). The city should feel like
those scenes made useful: a system you fly through and *know*. Drill-down
transitions expand contents outward from their parent (and contract back on
zoom-out), like unfolding a hologram.

## Metaphor hierarchy

| Level | Metaphor | Rendering |
|---|---|---|
| GitHub org | Country | (future: multiple repo islands) |
| Repo / top-level folder (e.g. `packages/canvas`) | State / district | Large ground plate + big label |
| Folder | City block cluster | Nested ground plates, streets = padding gaps |
| File | City block | Raised plate containing buildings |
| Module (function/class/interface/...) | Building | Instanced box, style varies by kind |

## Semantics

- **Height / footprint** = lines of code (log-scaled height).
- **Module kind → building style**: class = tall tower (blue), function = box (cyan),
  component (React) = pink/magenta tower, interface = translucent violet "glass",
  type = flat slab (slate), enum = amber, const = short gray.
- **Churn overlay**: 12-month commit-touch count → gray → yellow → UiPath orange (#fa4616) → red heat.
- **Fix hotspots overlay**: same ramp but weighted by commits whose subject matches /fix|bug/i.
- **Focus / recent-diff overlay**: files changed in last 30 days glow green, everything else dims — "where is the action right now".
- **Coupling**: import edges file↔file, aggregated folder↔folder. Drawn as glowing bezier arcs when a node is selected; optional top-level package↔package arc overlay.
- **People layer**: open PRs from GitHub. Author avatar sprite hovers over the centroid of the files the PR touches, with a light beam down. **Draft PRs render orange wireframe scaffolding boxes** around affected file blocks (work under construction).

## Interaction

- Orbit / zoom / pan (OrbitControls).
- Hover → HUD tooltip (name, kind, loc, churn, fix count, PRs touching it).
- Double-click → camera fly-to + focus that node (breadcrumb updates). Esc / breadcrumb → back up.
- Mode buttons (HUD): Structure · Churn · Fix hotspots · Recent focus. Toggles: Coupling arcs · People/PRs.

## Data contract — `viewer/public/data.json`

Produced by `analyzer/analyze.ts`. All ids are repo-relative POSIX paths.

```jsonc
{
  "repo": { "name": "my-repo", "root": "/abs/path", "analyzedAt": "ISO", "githubUrl": "https://github.com/acme/my-repo" },
  "tree": {                       // root folder node
    "type": "folder",             // 'folder' | 'file'
    "name": "packages",
    "path": "packages",           // == id
    "loc": 123456,                // sum of children
    "churn": 100, "fixChurn": 12, "recentChurn": 5,   // sums for folders
    "children": [ /* folder|file nodes */ ]
    // file nodes instead have:
    // "modules": [{ "name": "Foo", "kind": "class|function|component|interface|type|enum|const", "loc": 42, "exported": true }]
  },
  "edges": [ { "a": "packages/a/src/x.ts", "b": "packages/b/src/y.ts", "n": 3 } ],  // import coupling, deduped, n = import count
  "prs": [ { "number": 3055, "title": "...", "author": "someone", "avatarUrl": "https://avatars.githubusercontent.com/...", "isDraft": true, "updatedAt": "ISO", "files": ["packages/..."] } ]
}
```

Notes:
- `churn` = commits touching the file in last 12 months; `fixChurn` = subset with /\b(fix|bug)\b/i in subject; `recentChurn` = last 30 days.
- Edges only between files that both exist in the analyzed set. Workspace package imports (`@x/y`) resolve via packages' package.json names when possible.
- PR `files` filtered to files present in the tree.

## Data contract v2 (additions)

- **Edges are directional**: `{a, b, n}` means **a imports b** (dedupe per ordered pair, keep both directions if they exist).
- **Module spans + nesting**: each module gains `line` (1-based start line) and optional `children` for its internals — class methods/properties/accessors, interface members, enum members: `{ name, kind: 'method'|'property'|'accessor'|'member', loc, line }`. This powers module-level drill-down (inside a building).
- **Commit stream** (for the history timeline + sidebar):
```jsonc
{
  "files": ["packages/a/x.ts", ...],          // index table, positions referenced by commits
  "commits": [                                 // newest-first, last 12 months
    { "h": "abc1234", "ts": 1723939200, "a": "author", "s": "subject (≤100 chars)", "f": [0, 5, 9] }
  ]
}
```
  Only files present in the tree appear in `f`. Commits touching zero tree files are dropped.

## Dev API (vite plugin, dev-server only)

`viewer/vite.config.js` registers middleware that shells out to git in `repo.root` (read from the generated data.json at server start). All paths validated: repo-relative, no `..`/absolute, resolved path must stay under root; invalid → 400. Endpoints:

- `GET /api/source?path=<repo-rel>&start=<1-based>&end=` → `{ path, start, end, lines: [...] }` (cap 400 lines)
- `GET /api/log?path=` → `{ commits: [{h, ts, a, s}] }` — last 15 commits touching that path
- `GET /api/diff?path=&h=<hash>` → `{ diff: "unified diff text" }` — `git show <h> -- <path>`, cap ~400 lines; hash validated as /^[0-9a-f]{7,40}$/

Viewer must degrade gracefully when these 404 (e.g. static hosting): hide snippet/diff sections.

## Interaction v2

- **No cursor tooltip.** A persistent right sidebar shows hover info (top section, live) and pinned selection detail (on click): stats, PRs, recent commits for that path, and code — module source snippet + latest diff via the dev API. When the focused/selected node is file-level or deeper, the sidebar expands to a wide code pane showing the actual source (module span, or whole file capped).
- **Double-click = isolate.** Rendering the focused node's subtree ONLY, re-laid out to fill the stage: folder → its city; file → its modules as blocks; module → its `children` (methods etc.) as buildings. Breadcrumb/Esc rebuilds the parent scene. This is the hierarchy: org → repo → folder → file → module → member.
- **Map-style labels**: labels chosen dynamically from what's in view (projected size within a readable band, capped count, fade in/out) — district names give way to file names give way to building names as you zoom, like a map engine.
- **PR markers** connect visibly: avatar at centroid, thin beams down to EACH affected file plate + glowing ground ring per file. PRs gain `additions`/`deletions` in the data; the central beam's radius and glow scale with log(additions+deletions) so big PRs read as big pillars of light.
- **Directional arcs**: animated flow (moving dashes/pulses) from importer → imported.
- **History timeline**: bottom slider over the commit stream (12 months). Scrubbing sets a time cursor T; recent-focus highlights files touched in [T−30d, T]; sidebar shows the commits around T; play button animates the city through history.

## Style guide (hologram / future-dark)

- Background `#05080f`, exponential fog, faint cyan grid floor.
- Materials: emissive-heavy, slight transparency; additive-blended edge lines on focus; UnrealBloomPass for glow.
- HUD: monospace/uppercase, thin 1px cyan (#22d3ee) borders on translucent dark panels, orange (#fa4616) for active states. CSS scanline + vignette overlay for the retro-CRT feel.

## Strata buildings (planned — next major render mode)

Make BOTH dimensions of a building semantic: **height = commit count** (each
commit that touched the file is one fixed-height level) and **footprint area =
LOC at that commit's point in time**. The base level is the most recent commit
at current size; earlier strata stack upward — buildings grow from the bottom
like a tree, so the silhouette tells the file's life story:

- steady taper = grew gradually · straight tower = stable size, heavy churn
- top-heavy = recently shrunk · tall & thin = tiny file endlessly touched
- short & fat = big file nobody touches

Implementation: `git log --numstat` in the analyzer → per-commit `[adds, dels]`
aligned with the commit stream's `f` array; client reconstructs LOC-at-commit
by walking back from current LOC. One instanced slab per (file × commit) level
(~50–100k instances at flow-workbench scale). Per-level tint options: fix
commits as red strata; age gradient. The history timeline gains **two handles**
(start + current): only strata inside the range render, the current handle sets
the base snapshot — dragging the start handle back literally grows the city.
File-level only at first (per-function historical size needs per-commit
parsing); ships as a "Strata" mode alongside the log-scale massing.

## Analyzer cache & static export (planned)

- **Incremental analysis cache** — git history is append-only: persist the
  processed commit stream + numstat deltas in `.codecity/cache.json` keyed by
  the last-processed commit hash; subsequent runs only walk
  `git log <cached>..HEAD` and merge. Module extraction cached per file keyed
  by git blob SHA (`git ls-files -s`). Target: near-instant re-analysis.
- **Static export** — `npm run export`: vite-build the viewer with the current
  `data.json` baked into `dist/` as a self-contained static visualization
  (API-dependent panes already hide themselves). Use cases: GitHub Pages,
  internal doc hubs, attaching a city snapshot to a PR or design doc.

## Hierarchy legibility (planned — UX polish pass)

At repo scale it's hard to tell a top-level package from folders nested inside
it. The fixes, layered:

- **Elevated terraces** — folder plate elevation steps by hierarchy tier, so
  top-level districts sit visibly raised and nesting reads as stacked terraces.
- **Side-wall names** — top 1–2 folder tiers get their names rendered on the
  terrace side faces (plinth signage, camera-facing side); floating label pills
  only from level 3 down. Top-level names most visible.
- **Clickable labels** — every label joins the raycast set (click = select,
  double-click = isolate).
- **Parent→child label leader lines** — thin links from a parent's label to its
  children's labels, shown contextually (parent hovered/selected, or when two
  label tiers are visible) so containment is explicit without constant clutter.
- **Smooth hierarchical zoom** — drill/back transitions chain through each
  intermediate level instead of re-centering per jump.
- Sidebar polish: condensed PR/commit rows (expand on demand); identifiers in
  true case (no uppercase transform on data-derived names).

## Markdown support (planned)

Treat a notes vault / docs tree as a codebase: discover `.md` files; modules =
headings (nesting by heading depth → `children`); edges = relative markdown
links and `[[wikilinks]]` (resolved by filename/slug); new `section` building
kind. Churn/timeline/strata work unchanged — strata on a growing document is a
natural fit.

## Working-tree view (in progress)

`GET /api/status` (implemented) returns `git status --porcelain` as
`{changes: [{path, x, y, untracked}]}`. Viewer gains a "Working tree" layer:
modified files glow amber, untracked render as ghost outlines, deletions as red
voids; sidebar lists the changes; refresh on demand. Completes the time
spectrum: strata → 12-month timeline → 30-day recent → open PRs → **now**.
Dev-server (and future VS Code host) only; hidden on static exports.

## Tour SDK (planned — PR-review integration)

A TypeScript SDK for *codifying a guided tour of the city*, so a coding agent
(or a human) can walk reviewers through a PR or subsystem:

```ts
export interface Tour { title: string; steps: TourStep[]; }
export interface TourStep {
  target: string;            // path, path#module, or path:line-range
  title: string;
  narration: string;         // markdown, shown in the sidebar
  artifacts?: TourArtifact[];// diffs (commit/PR refs), images (demo shots), links
  camera?: 'isolate' | 'frame' | 'orbit';  // how to present the target
  highlight?: string[];      // additional paths/modules to co-highlight
}
```

The viewer gains a tour player (step list, next/prev, autoplay) that flies the
camera through each step, isolates/highlights targets, and renders narration +
artifacts in the sidebar. Tours load from a JSON/TS module or stream in live
from an agent (CityHost extension). The companion piece is an agent skill:
"generate a tour of this PR" — the agent reads the diff, picks the key
locations, writes the Tour object. Primary use case: PR reviews where the
reviewer flies the change instead of reading a flat file list.

## Future ideas (recorded, not scheduled)

- **Code coverage overlay** — ingest lcov/istanbul output; per-file and
  per-module coverage as a color ramp (uncovered = dark voids in the city).
- **Test pass visualization** — map test results onto the buildings they
  cover; watch a test run sweep the city green/red as it executes.

- **Debug adapter integration** — attach via DAP and show *live values streaming
  through the system*: data pulses traveling the import arcs / between buildings
  as the program runs, watched variables as glowing payloads. The city becomes a
  runtime instrument, not just a static map.
- **Coding-agent tours** — let a coding agent (Claude Code etc.) drive the camera
  and highlights to give a guided *tour of a PR or diff*: "here's the entry
  point, this interface changed, these three files consume it" — camera
  waypoints + narration + synchronized highlights. Same mechanism doubles as
  living documentation of an interaction (agent highlights the interfaces/files
  involved in a flow while explaining it). Natural extension of the
  city-as-shared-referent idea: the agent doesn't just read the city, it
  *presents* with it.
- **PR / diff focus mode** — first-class "show me this PR" view: isolate the
  PR's changed files plus their import blast-radius, dim the rest of the city,
  color by added/modified/deleted, with the diff in the sidebar. Entry points:
  a PR number, a branch, or `git diff main...`.
- History-resistant layout (persist per-path layout anchors across analyzer
  runs — EvoStreets lesson; spatial memory survives re-analysis).
- Hierarchical edge bundling for coupling arcs; org-level "country" view with
  two-tier semantic zoom.

## Project layout

```
shared/types.ts           # the data.json contract, shared analyzer <-> viewer
shared/host.ts            # CityHost adapter (HttpHost today, VS Code webview later)
analyzer/analyze.ts       # tsx analyzer/analyze.ts <repoPath> [--roots a,b] [--out viewer/public/data.json] [--no-prs]
viewer/index.html         # HUD markup + CSS
viewer/src/main.ts        # scene, interaction, overlays
viewer/src/vtree.ts       # the viewer's augmented node type (layout, synthetic scopes)
viewer/src/layout.ts      # squarified treemap layout
viewer/src/city.ts        # geometry/instancing builders
viewer/public/data.json   # generated (gitignored)
```
