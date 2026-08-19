# Tours — flying a reviewer through a change

A **tour** is a JSON file that scripts a guided walk through the city: a list of
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
6. **Hand it over.** Either write it to `viewer/public/tours/<name>.json` and
   tell the user to open `npm run dev` at `?tour=tours/<name>.json`, or paste it
   into the console as `window.cityTour.load({…})` against a city they already
   have open.

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

## Authoring tips

**Use `isolate` for "look inside this".** It drills into the target and
re-lays out that subtree to fill the stage — a file becomes a district of its
functions, a class becomes a district of its methods. It is the right treatment
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

## Playing a tour

- `?tour=tours/welcome.json` — relative, same-origin `.json` paths only.
- Drag a `.json` tour file onto the window.
- `window.cityTour.load(tourObject)` from the console or an agent bridge;
  `window.cityTour.exit()` ends it.

Controls: `←` / `→` step, `Esc` exits (before any other Esc behaviour), plus the
prev / next / autoplay / exit buttons on the bottom-left panel. Autoplay holds
each step for ~8 seconds and stops the moment the viewer touches the camera.
