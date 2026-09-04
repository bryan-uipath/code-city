# Tours — flying a reviewer through a change

A **tour** is a `.cctour` file — JSON, with an extension that says what it is —
that scripts a guided walk through the city: a list of
steps, each naming a place in the code, a camera treatment, some narration, and
optional artifacts (a diff, a screenshot, a link). The viewer's tour player
flies the camera, isolates or highlights the targets, and renders the narration
in the sidebar.

The intended author is a coding agent. Given a PR, an agent can read the diff,
decide which five to ten locations actually explain the change, and emit the
tour — so the reviewer *flies* the change instead of scrolling a flat file list.

## The agent recipe

1. **Read the change.** `gh pr diff <n>` (or `git diff main...HEAD`). Note the
   files, the moved/renamed symbols, and which files merely follow along.
2. **Pick 5–10 locations.** Not the biggest diffs — the ones that carry the
   idea: the entry point, the contract that changed, the two or three consumers,
   the risky bit, the test that pins it. Everything else is `highlight`.
3. **Order them as a story.** Where the change starts, what it forced, what it
   costs. One step, one idea.
4. **Write the narration for someone who has not read the diff.** Plain prose,
   a paragraph or three, blank line between paragraphs. No markdown syntax —
   the player renders narration as plain text, deliberately (tour files are
   untrusted input, so nothing in them is ever interpreted as markup).
5. **Attach artifacts** where they earn their place: the commit that introduced
   a file, a demo screenshot, a link to the PR or the design doc.
6. **Hand it over.** Either write it to `<name>.cctour` next to the project it
   describes and have the user drop it on the window, or paste it into the
   console as `window.cityTour.load({…})` against a city they already have open.
   Keeping the file with its own project is the preferred shape: the visualizer
   stays repo-agnostic and ships only the generic `welcome.cctour`.

The city must have been analyzed from the same repo the targets refer to
(`npm run analyze -- /path/to/repo`); a target the analyzer never saw reports
"not in this city" and the tour continues.

## Schema

```jsonc
{
  "title": "What this tour is about",
  "steps": [
    {
      // Required. One of:
      //   "path/to/file.ts"              a file
      //   "path/to/file.ts#SymbolName"   one module inside it
      //   "path/to/file.ts:120-180"      a line range
      "target": "shared/types.ts#CityData",

      "title": "The data contract",           // required, one line

      // Required (may be empty). Plain text; blank lines split paragraphs.
      "narration": "First paragraph.\n\nSecond paragraph.",

      // Optional. How to present the target:
      //   "frame"   fly to it, keep the surroundings visible  (default)
      //   "isolate" drill in: render only this subtree, re-laid out to fill
      //   "orbit"   frame it, then orbit slowly while the step is on screen
      "camera": "isolate",

      // Optional. Co-highlighted targets — same syntax as `target`.
      // The step's target burns brightest; everything unlisted dims.
      "highlight": ["analyzer/analyze.ts", "shared/host.ts"],

      // Optional, max 8.
      "artifacts": [
        // Fetched live through the dev server (`git show <commit> -- <path>`).
        // `path` defaults to the step's target path. Commit = 7–40 hex chars.
        { "type": "diff", "commit": "9db96f3", "path": "viewer/src/strata.ts" },

        // https: or data:image/…;base64 only. Rendered width-constrained.
        { "type": "image", "src": "https://…/demo.png", "caption": "After" },

        // https: only. Opens in a new tab.
        { "type": "link", "href": "https://github.com/…/pull/42", "label": "The PR" }
      ]
    }
  ]
}
```

Everything is validated at the boundary (`shared/tour.ts`, `validateTour`):
unknown fields are dropped, malformed steps and artifacts are skipped, URLs are
scheme-checked, and a file that yields no valid step is rejected outright.

## Checkpoints — narration pinned to time

Steps are pinned to *places*. A **checkpoint** is pinned to a *moment*: a
caption attached to a point in the repo's history that fires as the timeline
cursor crosses it — while the viewer scrubs, plays, or a script sweeps the
cursor. The caption types on beside a pulsing dot, holds, and fades; scrubbing
backwards past a checkpoint re-arms it.

```jsonc
{
  "title": "…",
  "steps": [ /* … */ ],

  // Optional, max 40. Alongside `steps`, not inside them.
  "checkpoints": [
    // A moment, given as either:
    //   "ts": 1755561600   epoch seconds — exact
    //   "at": 0.52         a 0..1 fraction of the timeline range — portable
    //                      across re-analysis of the repo
    // `ts` wins when both are present.
    { "at": 0.52, "title": "strata — buildings made of git history" },

    // Optional hold in seconds before the caption fades (0.3–30, default 1.6).
    // Captions that bunch up on a fast sweep queue and hold shorter.
    { "ts": 1755561600, "title": "the contract froze here", "hold": 3 }
  ]
}
```

Loading a tour arms only the checkpoints *ahead* of the current cursor, so
opening one at "now" does not replay the whole history at once. Exiting the
tour clears them. Titles are plain text, like narration — never markup.

Checkpoints are for the handful of moments that explain how the code got to its
present shape. Eight captions over a year of history reads as a story; forty
reads as a log.

## Authoring tips

**Use `isolate` for "look inside this".** It drills into the target, which keeps
the footprint it had in the city — a file becomes a district of its functions, a
class becomes a district of its methods. It is the right treatment
when the step is about the *internals* of one place, and the wrong one when the
point is where that place sits.

**Use `frame` for context shots.** The camera flies to the target and pins it in
the inspector without changing the scope, so the neighbourhood stays on screen.
This is the default, and the right choice for most steps: "this is the caller",
"this is where it lands".

**Use `highlight` for blast radius.** The step's target is what you are talking
about; `highlight` is everything the change *touches*. The player dims the rest
of the city, so a step targeting the changed interface and highlighting its six
consumers shows the reviewer the reach of the change in one frame — which is
exactly the thing a file list cannot show.

Two more, learned the hard way:

- **`orbit` is for silhouettes.** It is the only treatment that costs time
  (the camera keeps moving while the reader reads), so spend it on steps where
  the *shape* is the argument — a Strata tower, a district's massing.
- **Keep each step's narration under about a screen.** The sidebar shows
  narration above the artifacts; a long step buries its own diff.

## The `.cctour` extension

Tour files are named `<name>.cctour`. The contents are plain JSON — the
extension only marks the file as a tour, so it is recognisable in a file
listing and unambiguous to drop on the window. `.json` is still accepted
everywhere a `.cctour` is, for tours written before the rename; prefer
`.cctour` for anything new.

## Playing a tour

- `?tour=tours/welcome.cctour` — relative, same-origin paths only.
- Drag a `.cctour` file onto the window.
- `window.cityTour.load(tourObject)` from the console or an agent bridge;
  `window.cityTour.exit()` ends it. This is the path for a project that keeps
  its tours in its own repo: the viewer stays repo-agnostic and the tour is
  injected against a city it never had to ship.

Controls: `←` / `→` step, `Esc` exits (before any other Esc behaviour), plus the
prev / next / autoplay / exit buttons on the bottom-left panel. Autoplay holds
each step for ~8 seconds and stops the moment the viewer touches the camera.

## Scripting hooks

Two more globals exist for recordings and tests, siblings of `window.cityTour`:

```js
cityScript.hover("viewer/src/city.ts")   // show the hover callout + box for a
                                         // path; null clears. The next real
                                         // pointer move takes hover back.
cityScript.screenPos("viewer/src/city.ts")
// → { x, y, onScreen }  the path's rooftop projected to CSS pixels, so a
//   recording can aim a real mouse at a building.

cityCheckpoints.load([{ at: 0.5, title: "…" }])  // → count accepted
cityCheckpoints.show("one-off caption", 2)       // independent of the timeline
cityCheckpoints.busy()                           // a caption is up or queued
cityCheckpoints.clear()
```

`cityCheckpoints.load` runs the same validation as tour JSON, so input from a
script is trusted no further than input from a file.
