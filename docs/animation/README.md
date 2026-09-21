# README explainer

The README features a shorter **silent version**, with concise on-screen text
and no audio track. It keeps the same Jev → Decision → Discern → Procedures
progression. [Watch it](../assets/discern-explainer-silent.mp4) or
[read its text](transcript-silent.md).

Build the silent version (no speech setup needed):

```sh
uv run docs/animation/explainer.py --silent
uv run --python 3.13 docs/animation/export.py --silent
```

Edit its text in `silent-captions.json`. Each explanation stays on screen for
at least three seconds, with longer holds based on word count. The silent assets
use a `-silent` suffix; the narrated version below remains available separately.

## Narrated version

A narrated Manim lesson following one code change, from a Jev judgment to a
nested procedure invocation. [Watch with narration](../assets/discern-explainer.mp4),
read the [full transcript](transcript.md), or use the
[typechecked code example](../../examples/explainer.ts).

The narrated version is a 720p / 30 fps H.264 MP4 with AAC narration, visible captions, and chapter
metadata. A static poster and a separate SRT caption file are included in `../assets`.

## Rebuild

On Windows, install [uv](https://docs.astral.sh/uv/getting-started/installation/)
and [FFmpeg](https://ffmpeg.org/download.html), then run from the repository root:

```powershell
powershell -NoProfile -File docs/animation/narrate.ps1
uv run docs/animation/explainer.py
uv run --python 3.13 docs/animation/export.py
```

The script pins Manim 0.21.0 using inline dependency metadata; uv creates an
isolated environment without changing the library's JavaScript dependencies.
See [Manim installation](https://docs.manim.community/en/stable/installation/uv.html)
for platform prerequisites. Text uses Segoe UI and Consolas, available on Windows;
install these fonts or adjust `text()` to reproduce the typography elsewhere.
Narration uses the installed Microsoft Zira Desktop voice through System.Speech.
Use `-Voice 'Microsoft David Desktop'` to select that installed voice instead.
No LaTeX, paid voice service, model credentials, or external art is needed.
On other platforms, supply WAV files named `<chapter-id>-<cue-index>.wav` under
`media/audio/` for each cue in `narration.json`, and change fonts if needed.
The renderer measures each WAV and synchronizes animations and captions to it.

Edit narration in `narration.json` and visuals in `explainer.py`. Code excerpts
are extracted from `// video:name` sections in `examples/explainer.ts`.
Only the source scripts, transcript, and final assets belong in Git. Intermediate
renders and individual narration WAVs under `media/` are ignored. The exporter
regenerates the assets, captions, chapter metadata, and timestamped transcript.

## Content

1. **Jev:** context + a focused question → a typed judgment. Introduce Noul,
   Choice, and Score with concrete questions about the same change.
2. **Effect Decision:** define the question. **DecisionModel:** ask a provider.
   Show how Effect's names map to Jev's question types.
3. **Discern:** why a probability alone does not specify an action; match, miss,
   and uncertain; a complete policy; composition and shared observations.
4. **Procedures:** wrap a program; call it directly; route a request through a
   registry; explicitly handle an ambiguous request.
5. **Composition:** nest registries and trace the request through two routing
   decisions and one risk judgment. Contrast this with a known Effect sequence,
   then introduce depth limits and observation recording.

The change, estimates, and thresholds are illustrative, not live model results.
The simple policy is used in the procedure examples; the combined policy is a
separate extension. Direct `run` adds no routing inference, but its body may
still ask a model. Jev is one supported provider, not a Discern requirement.

## Verify the worked examples

With the repository's npm dependencies installed:

```sh
npx tsc --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --skipLibCheck --rootDir . --outDir docs/animation/media/example-run examples/explainer.ts
node docs/animation/check-example.mjs
```

This checks the example types and six execution paths against the actual library
using deterministic model answers, including the three-call nested path and
uncertainty preventing procedure execution. No provider credentials are used.

Concept references: [Jev and System One](https://docs.typesafe.ai/concepts/system-one),
[TypeSafe primitives](https://docs.typesafe.ai/primitives), installed Effect
`Decision` and `TypeSafeDecisionModel` sources, and this repository's implementation.
