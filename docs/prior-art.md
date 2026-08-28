# Prior art

Systems worth stealing from, mapped to our backlog.

## Code cities (core metaphor)

- **CodeCity** (Richard Wettel, USI Lugano, ~2008) — the canonical code city:
  classes = buildings, packages = districts, metrics → height/footprint/color.
  Established that the metaphor works for program comprehension. Our massing
  differs (files/strata, not classes), but its evaluation papers are the
  citation root for the whole genre.
- **M3triCity** (Lugano follow-up) — code city **with history**: the city
  evolves as you play commits, buildings age. Direct prior art for strata +
  timeline playback (and for the invert-strata question — their city grows
  forward in time).
- **CodeCharta** (MaibornWolff, active OSS, web) — 3D treemap city fed by
  pluggable metric importers (git churn, SonarQube issues, coverage, lcov).
  Best living reference for the metric-plumbing/importer architecture our
  language-generalization and diagnostics/coverage overlays need.
- **SoftVis3D** — SonarQube city plugin; issues-as-color prior art for the
  diagnostics-lights idea.
- **EvoStreets** (Steinbrückner & Lewerentz) — street layout derived from
  system evolution; the "history-resistant layout / spatial memory" lesson
  already cited in DESIGN.md.
- **FSN** (SGI) — the Jurassic Park file navigator; vibe ancestor.

## History & churn analytics

- **SeeSoft** (Eick et al., Bell Labs 1992) — files as columns, lines colored
  by age/author/churn. The 2D ancestor of strata: per-unit history as visual
  mass.
- **CodeScene / "Your Code as a Crime Scene"** (Adam Tornhill) — hotspot =
  churn × complexity, **temporal coupling** (files that change together),
  knowledge/ownership maps, all mined from git alone. Two takeaways:
  our fix-hotspot/churn overlays have validated semantics; and
  **change-coupling edges (co-commit) are a missing overlay** — we only draw
  import edges today, and the two disagree in interesting places.
- **Polyglot Code Explorer** (Korny Sietsma) — language-agnostic hex-tile
  city using indentation-based complexity + git temporal coupling. Best
  reference for analyzing languages without a parser (markdown, config,
  anything) — relevant to language generalization.

## Animated history & people

- **Gource** — repo history as an animated tree; contributors fly between
  files, beams touch what they change. The closest prior art for the agent
  visualization: presence, motion between sites, magnitude as beam
  intensity, activity that fades. Watch what makes it legible (few actors,
  strong trails) and what doesn't scale (all-history firehose).
- **code_swarm** (Ogawa) — commit particles orbiting files; prior art for
  short-lived activity effects (diff fly-bys, decay).

## Adjacent

- **GitHub Next "Repo Visualizer"** — 2D circle-packing repo map; simple,
  legible semantic zoom.
- **VR City / Primitive** — code cities in VR, per-commit walkthroughs;
  mostly proof that the camera/motion work matters more than the geometry.

## What nobody has shipped (our openings)

- Strata massing (commit stacks as the *shared* massing across overlays).
- A live agent layer — Gource is post-hoc replay; nobody renders an LLM
  agent working the codebase in real time.
- Tour SDK / guided PR walkthroughs in a city.
- City as an IDE surface (panes, follow mode, editor round-trip).
