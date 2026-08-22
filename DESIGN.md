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
- Mode buttons (HUD): Structure · Churn · Fix hotspots · Recent focus · Strata.
  **The mode never changes the massing** — at folder scope all five stand on the
  same strata stacks and only repaint them (see "Strata as the shared massing").
  Toggles: Coupling arcs · People/PRs.
- Legend swatches (Strata): click a commit type to filter the stacks; "only"
  compresses them to the matching commits (see "Strata filter").

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
    { "h": "abc1234", "ts": 1723939200, "a": "author", "s": "subject (≤100 chars)",
      "f": [0, 5, 9], "d": [[12, 3], [0, 40], [5, 5]] }   // d = [adds, dels] per f entry
  ]
}
```
  Only files present in the tree appear in `f`. Commits touching zero tree files are dropped.
  `d` comes from `git log --numstat`: binary files (`-`) are skipped entirely and
  renames (`old => new`, `dir/{a => b}/x.ts`) resolve to the new path.

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

## Strata as the shared massing (implemented)

Strata is no longer one mode's geometry: **at every folder scope, in every mode,
a file is its stack of commits.** The silhouette carries the history and the
mode carries the metric, so switching modes is a pure recolor — the city never
reshuffles under you, and comparing "where is the churn" with "where is the
recent work" is comparing two paints of one shape.

- `strataActive()` = a commit stream exists **and** the scope root is a real
  folder. Mode is not part of it. Without a stream (v1 data) the city falls back
  to module massing everywhere.
- **Structure** paints each stack with the file's *dominant module kind* (the
  kind owning most of its lines): at org zoom a per-module building is sub-pixel
  anyway, so the kind that characterizes the file is the honest signal.
  **Churn / fix / recent** paint the whole stack with that file's heat or
  recency — per-level uniform, since the level bands are already spoken for by
  the shape. **Strata** keeps the per-level conventional-commit colors.
  All of that is one `StrataPaint` swapped through `recolor()`; the search /
  tour highlight and the working-tree amber are two more paints in the same seam.
- **Module buildings appear when you isolate a file** (or a module). That is
  where kind, size and nesting resolve, and it is unchanged.
- The **range handle is therefore live in every mode** — it changes the massing,
  and the massing is shared. It hides only inside a file/module isolate, where
  there are no stacks.
- The legend gains the massing footnote (`level = commit · area = loc`) in the
  non-strata modes, and Structure notes that kinds resolve inside a file.
- Cost: one `InstancedMesh` for the whole city, allocated for the widest range.
  flow-workbench (3.7k files / 17.7k levels) holds 60fps at org level, including
  timeline playback, which rewrites every matrix ~8×/s.

## Strata filter — the legend as a query (implemented)

The Strata legend's commit-type swatches are **controls**, not captions: click
one and the city answers "where does this kind of work live". A filter is a
second predicate on levels, sitting next to the time range, and the two compose
— *"only fix strata in Q1"* is a sentence the seam can already say.

- **Two states, one selection.** A selected set of types is a **highlight** by
  default: matching levels keep the mode's paint, everything else drops to ~10%
  brightness. The silhouette survives on purpose — the question is *where the
  fix work sits inside the whole history*, which needs the whole history to
  still be standing. The **"only"** toggle promotes the same set to a
  **collapse**: non-matching levels are not built at all, stacks recompress from
  the base, and height becomes "matching commits only" — a skyline of pure fix
  mass. Multi-select accumulates (feat + fix).
- **The split is the existing geometry/color split.** Highlight is `recolor()`
  with the mode's paint wrapped in a ghosting pass (`ghostedPaint`); collapse is
  a `LevelFilter` handed to `update()`, the same call a range drag makes, with
  one more predicate on it. So a filter change is either a repaint or a refill —
  never a rebuild, never a relayout. The LOC walk still steps through the
  rejected commits, so a surviving slab keeps its true size at that moment.
- **Fix hotspots is now a shortcut into this.** Wherever there are stacks to
  filter, the mode button lands you in Strata with `fix` selected — per commit
  instead of per file. The flat heat ramp remains only as the fallback for a
  city with no stacks (v1 data, or inside a file isolate), and the legend says
  so.
- **Scope of a filter.** It outlives the overlay mode (every mode's legend can
  clear it, and shows which types are armed), because the massing it changes is
  shared. It does **not** outlive the massing: isolating into a file drops the
  stacks, so the filter clears with them rather than lying in wait.
- **Esc precedence**: palette > tour > search results > filter > scope pop. A
  filter is a query laid over the current scope, so it comes off before the
  scope does.
- Stats and inspector follow: the LEVELS counter reports *visible* levels, and a
  selected file gets `N of M commits match filter`. Hovering a ghosted level
  still resolves and inspects normally. The search / tour highlight still
  outranks the filter's ghosting — it replaces the paint outright.

## Strata buildings (implemented — the "Strata" render mode)

Make BOTH dimensions of a building semantic: **height = commit count** (each
commit that touched the file is one fixed-height level) and **footprint area =
LOC at that commit's point in time**. The base level is the most recent commit
at current size; earlier strata stack upward — buildings grow from the bottom
like a tree, so the silhouette tells the file's life story:

- steady taper = grew gradually · straight tower = stable size, heavy churn
- top-heavy = recently shrunk · tall & thin = tiny file endlessly touched
- short & fat = big file nobody touches

Shipped as an exclusive render mode (`viewer/src/strata.ts`), file-level only:

- The analyzer's `git log --numstat` pass emits per-commit `[adds, dels]` aligned
  with the stream's `f` array; the viewer reconstructs LOC-at-commit by walking a
  file's commits newest → oldest, subtracting `adds − dels` from today's LOC
  (floor 1). Slab area = `locAtCommit / baseLoc`, clamped to [0.06, 1], so the
  side scales by its square root; level height is fixed at 1.6 world units.
- One `InstancedMesh` with per-instance colors for the whole city — ~17.5k levels
  over 3.7k files at flow-workbench scale, 60fps. The buffer is allocated for the
  widest possible range, so dragging a handle only rewrites matrices and colors.
  Files are capped at **120 levels** (a handful of hot files have 150+ commits);
  a file with no commit in range gets one thin plinth so it still reads.
- **Level color = the kind of change**: conventional-commit type
  (`/^(\w+)(\(.*?\))?!?:/`) → hue — feat cyan, fix red, refactor violet, perf
  pink, test amber, docs green, chore slate, ci/build gray — with brightness
  rising toward the newest level. Subjects with no type fall back to the plain
  age gradient (dim violet → bright cyan). Geometry and color are separate
  passes (`update()` vs `recolor(paint)`), which is the seam the eventual
  "strata as the universal massing, overlays as pure recolors" step needs.
- **Two timeline handles**: the start handle (cyan) sets the
  oldest level rendered; the existing cursor sets the base snapshot — LOC is
  rewound past every commit newer than it. Dragging start left grows the city.
- Hover/select resolves a level to its file and shows that level's commit
  (hash · subject) in the inspector. Isolating a file from Strata falls back to
  normal module massing inside the file scope (per-function history would need
  per-commit parsing).

Level colors encode conventional-commit type: feat cyan · fix red · refactor
violet · chore slate · docs green · test amber · perf pink · ci gray · unknown =
age gradient. (Shipped follow-up: the stacks became the shared massing for every
mode — see "Strata as the shared massing" above.)

## Analyzer cache & static export

- **Incremental analysis cache** (implemented) — git history is append-only, so
  the processed stream (with its numstat deltas) is persisted under **this**
  project at `.codecity/<sha1 of the analyzed repo root>.json`, never inside the
  analyzed repo. A run hits the cache when the cached HEAD is still an ancestor
  of today's HEAD (`git merge-base --is-ancestor`) and today's file set is a
  subset of the cached one; it then walks `git log <cachedHead>..HEAD --numstat`
  only, prepends those commits, drops anything past the 12-month cutoff, and
  rewrites the cache. Anything that does not line up — parse error, moved HEAD,
  new files, changed roots — silently falls back to the full pass. Churn is
  always recomputed from the merged stream, so cached and full runs produce
  byte-identical output. flow-workbench: 3.8s → 0.1s for the history pass
  (6.9s → 2.1s end to end; the remainder is TypeScript parsing, which is not
  cached yet — per-blob module caching is the obvious next step).
- **Static export** — `npm run export`: vite-build the viewer with the current
  `data.json` baked into `dist/` as a self-contained static visualization
  (API-dependent panes already hide themselves). Use cases: GitHub Pages,
  internal doc hubs, attaching a city snapshot to a PR or design doc.

## Hierarchy legibility (implemented — UX polish pass)

At repo scale it was hard to tell a top-level package from folders nested inside
it. The fixes, layered:

- **Elevated terraces** — plate elevation steps by hierarchy *tier*, not depth:
  `TIER_LIFT = [10, 6, 3.4, 2, 1.3]` world units (0.9 beyond), and a plate's
  side wall reaches all the way down to its parent's surface, so the stack reads
  as solid steps rather than floating slabs (`plateTop` / `plateThickness` in
  `layout.ts`). A folder with a single child (repo → packages) is a
  *pass-through*: it shares its child's tier instead of spending a whole step on
  no information, with a per-depth 0.012 nudge so the two never z-fight.
- **Side-wall names** (`viewer/src/terrace.ts`) — the top two folder tiers get
  their names on the terrace side face: one canvas-texture plane per folder,
  re-seated every 200ms onto whichever of the four faces currently points at the
  camera, faded in by projected wall height. Those folders are dropped from the
  floating label pills, which now start at tier 3.
  Sized on the wall alone a top-level name is ~10px at the org overview, so the
  **top tier holds an apparent size**: it grows (up to 2.2× its wall, bottom-
  anchored on the terrace edge so it never sinks into the plate below) until the
  letters read ~15px, and shrinks back to the wall as you approach. Deeper tiers
  deliberately do not — a sign that outgrew its wall there would float over the
  terrace above it. The first tier step is also 13 units rather than 10, since
  that step *is* the wall the loudest signage lives on.
- **Clickable labels** — label sprites and side signs carry their node in
  `userData` and are raycast *before* the geometry (they draw on top, so they
  pick on top): click selects, double-click isolates.
- **Parent→child label leader lines** — one dynamic `LineSegments` in the
  labeler links a parent label to its visible children, shown only when that
  parent is hovered/selected or when exactly two label tiers are on screen, and
  cross-faded like the labels themselves.
- **Smooth hierarchical zoom** — see *Camera motion* below.
- Sidebar: condensed one-line PR rows (`#3123 · title… · draft · @author · 2h ·
  +adds −dels`, click for full title + file count) and commit rows (hash ·
  subject · author · age, five then "+N more"); identifiers render in true case
  (only panel titles stay uppercase). Same rule in 3D — folder names are
  uppercase city signage, file and module names are identifiers.

## Camera motion

Every zoom in the city is one gesture: one move of the camera, one unfold of the
scene, one continuous world underneath both. The rules, in the order they matter:

- **The world never teleports.** Each scope is laid out around the origin, so a
  rebuild would drop the new section at a different place than the old one stood
  and the camera would have to absorb the jump. Instead the stage is *homed*
  (`startTransition`): the new layout is translated so the anchor — the node
  being drilled into, or the child being backed out of — lands exactly on the
  world position it already occupied, and only the SCALE animates from there.
  The section grows (or folds) about the spot it already stood on. Everything
  derived from a layout rect carries `stageHome`: framings, labels, callouts;
  the selection boxes just ride the stage. Once everything settles, `rehomeStage`
  shifts stage, camera and orbit target back to the origin together — invisible,
  and it keeps the drift bounded.
- **The camera moves in its own coordinates, not in Cartesian space.** The orbit
  TARGET follows a smooth centripetal Catmull-Rom through the centres of the
  levels the jump passes; the camera hangs off that target by a bearing, a pitch
  and a distance, and each of those makes exactly ONE monotone move from the
  pose it is in to the pose the destination framing asks for. Splining the
  camera itself through the intermediate framings is what used to make a dive
  wobble and tilt — a nest of treemap cells puts consecutive centres on
  alternating sides, and a curve dragged through their bearings zig-zags.
- **The route is straightened before it is flown** (`straightenRoute`). A stop
  that does not advance toward the destination is dropped, and the sideways part
  of the rest is capped at 22% of the route: a level is a place the flight
  *passes*, not a gate it has to hit. What survives is a bow, never a hairpin.
- **Even APPARENT speed.** The path is walked by arc length, but the arc is
  measured in apparent motion — world distance divided by the distance to what
  you are looking at — so a hundred units covered from a thousand away and the
  same hundred covered from fifty away are not counted the same. Under one
  global trapezoid ease (sine ramp up, constant cruise, sine ramp down; a plain
  ease-in-out for a single-level hop) this is what keeps a four-level dive from
  reading as a lunge.
- **Crane shaping, solved rather than clamped.** The distance schedule closes in
  geometrically with an exponent: >1 holds a dive high and brings it down late,
  <1 gets a climb its height up front. When that is not enough to clear the
  skyline, the exponent is *raised* until it is (bisection, capped at 3.5) —
  never clamped, because a clamp puts a corner in the path exactly where the
  crane starts coming down. A destination whose orbit distance is smaller than
  the city is tall cannot be reached without descending through the skyline;
  there the cap is the deliberate compromise.
- **The unfold rides the flight.** While a flight is in the air the stage
  transition is not on its own clock: `transition.t` is a smoothstep over a
  window of the flight's own eased progress — `[0.04, 0.86]` drilling in, so the
  section is still opening as you arrive, `[0, 0.55]` backing out, so the parent
  city is whole again before the camera pulls off it. Zero velocity at both ends
  of the window means neither start nor finish kicks.
- **The old scope stays up.** Drilling in does not dispose the city you were
  looking at: it is parked at the world position it already had and faded out
  over the first ~85% of the flight (`retireCity`), so the block you picked grows
  out of a city that is still standing around it rather than out of an empty grid.
- **Transit dressing.** Labels and terrace signs freeze their re-pick and fade to
  nothing at launch, re-pick once on arrival and fade back in; hover, callouts
  and the highlight boxes are suppressed while the camera is moving. Nothing
  churns mid-flight and nothing pops.
- **Durations** are `0.55s + 0.26s per level + up to 0.67s for apparent
  distance`, capped at 2.2s, and 0.86× coming back out — a retreat, not an
  approach. A long inward dive also breathes +2° of FOV at mid-flight; framings
  are always computed at the base FOV so a flight retargeted mid-breath still
  aims correctly.
- **Anything the user does outranks it.** The OrbitControls `start` event cancels
  the flight from wherever it is (no snap) and hands the unfold to a 0.15s
  finish; a new dblclick / breadcrumb / Esc retargets from the current camera
  pose, carrying the speed the camera already has into the new ease (a cubic
  Hermite with a matching initial slope) so a rapid Esc-Esc-Esc chain never
  stalls between levels.
- **`?probe=1`** exposes `window.__motionProbe`: a per-frame camera trace into a
  preallocated buffer plus scripted `focusPath` / `reveal` / `up` drivers, for
  asserting frame-to-frame speed continuity, monotone pitch and bearing,
  skyline clearance, and screen-space continuity of the drilled node across the
  rebuild frame. Off — and free — without the flag.

## Markdown support (planned)

Treat a notes vault / docs tree as a codebase: discover `.md` files; modules =
headings (nesting by heading depth → `children`); edges = relative markdown
links and `[[wikilinks]]` (resolved by filename/slug); new `section` building
kind. Churn/timeline/strata work unchanged — strata on a growing document is a
natural fit.

## Search (implemented — ⌘P paths/modules · ⌘F contents)

One palette, two modes (`viewer/src/search.ts`), both driving the same city
reaction: matches glow white-cyan, everything else dims, the row under the
keyboard cursor pulses. It is a recolor pass over whatever is standing —
buildings inside an isolate, strata stacks at folder scope — and closing the
palette hands the city back to its overlay.

- **The ⌘F results outlive the palette.** The palette is a launcher; the work
  queue is the sidebar's SEARCH section, mirrored through a `results(view|null)`
  host verb. A file row selects and flies; unfolding it lists the matched lines
  with the query marked, and a line row opens the code pane on that span through
  the existing `Descriptor.span` machinery.
- It clears on Escape (which retires the list *before* it starts popping the
  focus stack) or as soon as you pick something else in the city — that click is
  the end of the errand.
- `markHtml` (sidebar.ts) is the single escape-then-mark helper both the palette
  rows and the sidebar mirror render through: paths, source lines and the echoed
  query are all escaped before the `<mark>` wrapping.

## Working-tree view (implemented)

`GET /api/status` returns `git status --porcelain` as
`{changes: [{path, x, y, untracked}]}`, reached through `CityHost.getStatus()`.
The "Working tree" toggle in Layers completes the time spectrum: strata →
12-month timeline → 30-day recent → open PRs → **now**.

- **Modified** files glow amber (`#fbbf24`) — a recolor pass layered *on top of*
  the active overlay, so churn/recent/structure still read underneath (the
  search highlight outranks both, exactly as the PR layer does).
- **Untracked** files get a green ghost outline where they have a plate; files
  the analyzer never saw (new files, non-source paths, untracked directories)
  appear in the sidebar list only. **Deleted** files get a red ghost while their
  plate still exists.
- The sidebar section groups the changes modified / untracked / deleted, each
  row clickable (select + fly), with a refresh button that re-reads git.
- The toggle only appears once `/api/status` has answered, so a static export
  never shows a control it cannot serve.

## Tour SDK (implemented — PR-review integration)

A tour *codifies a guided walk through the city*, so a coding agent (or a human)
can fly reviewers through a PR or subsystem instead of handing them a flat file
list. The contract lives in `shared/tour.ts`:

```ts
export interface Tour { title: string; steps: TourStep[]; }
export interface TourStep {
  target: string;            // path, path#module, or path:start-end
  title: string;
  narration: string;         // plain text; blank lines split paragraphs
  artifacts?: TourArtifact[];// { diff, commit, path? } | { image, src } | { link, href }
  camera?: 'isolate' | 'frame' | 'orbit';
  highlight?: string[];      // co-highlighted targets — the blast radius
}
```

- **Untrusted by construction.** A tour is JSON from anywhere, so it crosses one
  boundary: `validateTour(x: unknown): Tour | null` narrows field by field and
  rebuilds the object from validated pieces (no `as`, no surviving extra keys),
  dropping malformed steps/artifacts, capping sizes, and scheme-checking every
  URL (images: `https:` or `data:image/…;base64`; links: `https:` only).
  Narration is rendered as **escaped plain text with paragraph breaks — never
  markdown-to-HTML**, so a hostile tour can neither script nor style anything.
- **The player** (`viewer/src/tour.ts`) owns the bottom-left HUD panel (step
  x/y, prev/next, autoplay, exit — it takes `#help`'s slot) and a TOUR section
  that displaces SELECTED in the sidebar. Autoplay holds ~8s a step and stops on
  any user camera input (the OrbitControls `start` event).
- **Everything it does to the city is existing machinery**, reached through five
  host verbs implemented in main.ts: `frame` = `revealPath` (select + fly),
  `isolate` = reveal then `focusNode(focusTargetFor(...))`, `orbit` = frame plus
  `controls.autoRotate` (suspended while a flight is writing the camera
  position), `highlight` = the search-highlight recolor pass with the target at
  full weight and the co-highlights at 0.62, `getDiff` = `CityHost.getDiff`, so
  diff artifacts are tinted by the same `diffHtml` as the inspector's diff pane.
- **Esc outranks everything**: a running tour eats Escape (and ←/→) before the
  focus-stack pop, and exiting restores the overlay, the selection and the
  normal Esc behaviour.
- **Three ways in**: `?tour=<relative path>` (same-origin relative paths only —
  absolute, cross-origin and `..` are refused), drag-and-drop of a file onto the
  window, and `window.cityTour.load(tour)` for live agent injection. All three
  run the same validator. Tour files are named `.cctour` (plain JSON with an
  extension that names what it is); `.json` stays accepted for older tours.
  `window.cityTour.load` is the path for a project that keeps its tours in its
  own repo — the visualizer ships only the generic welcome tour.
- `viewer/public/tours/welcome.cctour` is a worked example: nine steps through
  this repo's own pipeline (analyzer → contract → layout → city → strata → host
  seam → inspector → checkpoints), with a real diff artifact and links, plus
  eight checkpoints pinned across its history. It expects `npm run analyze -- .`.
- **Checkpoints** (`viewer/src/checkpoints.ts`) are the time-axis counterpart to
  steps: a tour's `checkpoints[]` pin captions to moments (`ts`, or `at` as a
  fraction of the timeline range), and each fires as the timeline cursor crosses
  it. Loading arms only what is ahead of the cursor; scrubbing back re-arms.
  Captions crossed together queue in chronological order and hold shorter while
  the queue is backed up.

The companion piece is the agent recipe in `docs/tours.md`: read the diff, pick
the 5–10 locations that carry the idea, emit the `.cctour`, hand the user
`npm run dev` plus `?tour=`, a file to drop, or `window.cityTour.load`.

## Future ideas (recorded, not scheduled)

- **VS Code extension** (deliberately deferred until the core UX and fit &
  finish are nailed): the city as a webview panel — a `VsCodeHost` implements
  `CityHost` over postMessage (strict CSP, no network), the analyzer runs on
  the workspace with the incremental cache, the extension host mirrors the
  vite dev-API semantics (same path containment/caps), `O` opens the selected
  file at its line in the editor, reveal-active-file selects it in the city,
  tours and the working-tree layer ride along. The `CityHost` seam already
  exists for exactly this.

- **Code coverage overlay** — ingest lcov/istanbul output; per-file and
  per-module coverage as a color ramp (uncovered = dark voids in the city).
- **Test pass visualization** — map test results onto the buildings they
  cover; watch a test run sweep the city green/red as it executes.

- **Debug adapter integration** — attach via DAP and show *live values streaming
  through the system*: data pulses traveling the import arcs / between buildings
  as the program runs, watched variables as glowing payloads. The city becomes a
  runtime instrument, not just a static map.
- **Live agent tours** — the Tour SDK ships the scripted case; the open half is
  a *streaming* one, where an agent drives the camera turn by turn over a
  channel (CityHost extension) instead of emitting a finished file, so it can
  present with the city while it is still reasoning about it.
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
shared/tour.ts            # Tour SDK types + validateTour (the untrusted-input boundary)
analyzer/analyze.ts       # tsx analyzer/analyze.ts <repoPath> [--roots a,b] [--out viewer/public/data.json] [--no-prs]
viewer/index.html         # HUD markup + CSS
viewer/src/main.ts        # scene, interaction, overlays
viewer/src/vtree.ts       # the viewer's augmented node type (layout, synthetic scopes)
viewer/src/layout.ts      # squarified treemap layout
viewer/src/city.ts        # geometry/instancing builders
viewer/src/labels.ts      # map-style dynamic labels + parent->child leader lines
viewer/src/terrace.ts     # district names on the terrace side walls
viewer/src/strata.ts      # Strata mode: per-commit slab stacks + their paints
viewer/src/tour.ts        # tour player: HUD panel, steps, autoplay, tour loading
viewer/public/tours/       # bundled tours (welcome.cctour = this repo's own architecture)
viewer/public/data.json   # generated (gitignored)
```
