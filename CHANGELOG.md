# Changelog

This project is pre-1.0 and the API still moves between minor versions.

## 0.3.0

Nothing was published before this, so none of the breaking changes below have
a migration path to honour — they are recorded for the sake of the history.

### Observation handling moved out of the matcher

Recording, replay, caching and budgets are now **interceptors of the
`DecisionModel` service** rather than features of a matcher. They apply to any
Effect program that reaches a `DecisionModel`, including programs built from
several matchers and code that never mentions Discern.

Observations are **content-addressed** by `(decision definition, encoded
input)`, which makes a recording and a cache the same data structure.

- **Added** `Discern.Model`: `recording`, `replaying`, `caching`, `budgeted`,
  `intercept`, `layer`, `fromProvider`, `replayLayer`, `store`, `budget`,
  `region`, `tree`, `provider`, `unavailable`, `isBudgetExceeded`,
  `isReplayMiss`.
- **Removed** `Discern.cached`, `Discern.TraceCache`, `Discern.memoryCache`.
  Use the `caching` interceptor; the user-supplied cache key is gone, because
  the content address replaces it.
- **Removed** `ReplayMismatchError`. A changed decision now has a different
  address, so it is simply absent rather than detected after the fact.
- **Changed** `Policy.replay(input, observations)` takes `Observations`, not a
  `Trace`. Replay is a layer, so a program containing several policies replays
  as a whole.
- **Changed** `Trace` (v2) is case-level diagnostics only: which cases ran, how
  each resolved, which branch was taken. It is no longer what you replay from.

### Procedures

- **Added** the `discern/procedure` entry point: `make`, `registry`, `route`,
  `invoke`, `fromRegistry`, `withMaxDepth`, `fromEffect`,
  `RoutingUncertainError`, `DepthExceededError`.
- Routing reads the whole classification distribution rather than the
  provider's chosen label, and returns `Uncertain` instead of resolving a
  near-tie. `registry.decision` is an ordinary pattern, so `Discern.Eval`
  measures the router.
- Registries are homogeneous in input, enforced in the types. `DecisionModel`
  has no structured generation, so routing can select a procedure but never
  construct its input.

### Renames

- `Program` → `Policy`.
- `Scope` → `DecisionScope`, and the undocumented `scope` alias for `on` is
  gone. Effect's own `Scope` made three meanings of the word.
- `Capability` → `Procedure`. "Capability" has a prior claim in systems
  security, where it means an unforgeable reference conferring authority.

### Added

- `Discern.ask(node, input)` runs one schema-scoped decision outside a matcher.
- `examples/walkthrough.mjs`, run by CI.
- `test/integration.types.ts` compiles the documented `@effect/ai-typesafe`
  wiring, so the README cannot drift from the packages it describes.

### Fixed

- Content addressing hashed decisions with **sorted** keys, so reordering a
  classification's criteria produced the same address. Criteria reach the
  provider in declaration order and can change the answer, so that was a silent
  reuse of an answer produced under a different prompt. Decisions are now
  hashed as written; inputs stay structural.
- `MemoryStore.load` merged instead of replacing, so a decision deliberately
  absent from a second fixture was still answered from the first — replay
  succeeded where it should have missed.
- `budgeted` accepted a structurally-typed `Budget` and then called a private
  hook on it, throwing a `TypeError` that escaped as a defect rather than the
  `AiError` the `decide` signature promises. `Budget` now carries a brand.
- `criteria` and the interceptor's split maps were plain object literals, so an
  id of `__proto__` set no own property and vanished silently.
- `Eval.sweep` called `pattern.evaluate` without the preview guard `dispatch`
  uses, and asked for every decision statically. It now skips decisions that
  deterministic structure already settles.
- Decision fingerprints widened from 32 to 64 bits.
- Clear errors instead of crashes or silence from `Discern.ask` on an unscoped
  decision, `Registry.get` on an unknown id, and `Eval.calibrate` on an empty
  candidate list.
- The whole test suite never ran: it installed a provider on `globalThis` that
  nothing read, so every async test failed on a missing `DecisionModel`.

### Documentation

- `effect@latest` is 3.x and `@effect/ai-typesafe@latest` is a publishing
  placeholder, so both must be installed with the `rc` tag. The previous
  install instructions produced a non-working setup.
- `TypeSafeClient.layerConfig()` requires an `HttpClient`; the documented
  wiring was missing that layer and would not have compiled.

## 0.2.0

Initial state of this repository: semantic patterns, tri-state matching,
compiled plans, traces, replay, a trace cache, and evaluation.
