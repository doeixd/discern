# README explainer

A silent, captioned Manim video introducing Discern's evidence, uncertainty,
ordered policies, observation reuse, and procedure routing. All examples use
illustrative model answers, not recorded provider output.

The root README embeds the complete looping GIF and links to the higher-quality
720p / 30 fps H.264 MP4. A static poster is also included in `../assets`.

## Rebuild

Install [uv](https://docs.astral.sh/uv/getting-started/installation/) and
[FFmpeg](https://ffmpeg.org/download.html), then run from the repository root:

```sh
uv run docs/animation/explainer.py
uv run --python 3.13 docs/animation/export.py
```

The script pins Manim 0.21.0 using inline dependency metadata; uv creates an
isolated environment without changing the library's JavaScript dependencies.
See [Manim installation](https://docs.manim.community/en/stable/installation/uv.html)
for platform prerequisites. Text uses Segoe UI and Consolas, available on Windows;
install these fonts or adjust `label()` to reproduce the typography elsewhere.
No LaTeX, voice service, model credentials, or external art is needed.

Only the source scripts and final assets belong in Git. Intermediate renders
under `media/` are ignored. The exporter overwrites the three generated assets.

## Content

1. Effect Match handles facts; Discern handles semantic evidence.
2. Required distinct decisions are batched, with observations reused by patterns.
3. `atLeast(0.8, { missBelow: 0.5 })`: match at or above .80, miss at or below
   .50, uncertain in between. The animation uses .62.
4. The first uncertain case stops fallthrough and invokes `onUncertain`.
5. Traces, replay, and calibration make policies inspectable and measurable.
6. A .52 / .48 procedure split fails the displayed .70 probability and .15
   margin requirements; the example supplies an uncertainty handler.

The animation uses a single risk rule for clarity. Additional decision kinds,
pattern composition, budgets, and nested registries are covered by the main README.
