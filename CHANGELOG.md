# Changelog

This project is pre-1.0 and the API still moves between minor versions.

## 0.5.0

Mistakes that used to compile or replay quietly are now refused.

### Upgrading from 0.4.0

Most programs upgrade without changes. Check for these:

- A `classify` or `rate` whose `criteria` is typed `string` (for example a
  `Record<string, string>` loaded at runtime), contains a template label, or is
  empty no longer compiles. Wrap an Effect `Decision.classify` with
  `Discern.decision` and read it with `where`, or route with
  `Procedure.registry`.
- `above` or `atLeast` with a `missBelow` above the threshold, and `below` or
  `atMost` with a `missAbove` under it, now throw `InvalidThresholdError` when
  the pattern is built.
- `between` with its ends reversed, such as `risk.between(0.6, 0.4)` or
  `severity.between("major", "minor")`, now throws `InvalidRangeError` when the
  pattern is built. It could never match.
- `Eval.calibrate` needs at least one value in `values`. A variable typed
  `V[]` must be shown non-empty, for example as `[first, ...rest]`.
- Tests that match the old threshold or id-collision messages with a regex
  should check `instanceof InvalidThresholdError` or
  `instanceof DecisionIdCollisionError` instead.
- A stored observation that fails validation now fails replay and cache reads,
  where it used to be used as-is. Recordings Discern wrote itself are
  unaffected.

### Added

- **`Discern.Model.Observations` and `Discern.Model.Observation` are
  schemas**, and the types of the same names now derive from them. A snapshot
  read back from outside the program can be decoded with
  `Schema.decodeUnknownSync(Discern.Model.Observations)` rather than cast, so a
  malformed or foreign recording is refused at the boundary.
- **`Discern.Model.isInvalidObservation`** recognises the failure raised when a
  stored answer fails validation (see Fixed).
- **`Discern.InvalidThresholdError`, `Discern.InvalidRangeError` and
  `Discern.DecisionIdCollisionError`** name the mistakes Discern catches while a
  policy is being built. All three are thrown, not failures on the error
  channel: they are faults in the policy's definition, which no run can
  encounter, so they stay out of every run's error type.

### Changed

- **`classify` and `rate` refuse label sets the compiler cannot enumerate.**
  A `criteria` whose labels are `string` (such as a `Record<string, string>`),
  include an infinite template such as `` `tone-${string}` ``, or are empty is
  now a compile error, standalone and through `Discern.on(schema)`. Every
  label check compares against the label union, so with an open set a typo in
  `is`, a duplicate `caseOf`, or a missing case under `exhaustive` all
  compiled; with an empty set, `exhaustive` passed without a single case.
  Labels known only at runtime go through `Discern.decision`, read with
  `where`, or through `Procedure.registry`, whose routing is unaffected.
- **`above`, `atLeast`, `below` and `atMost` check their miss bound.** A
  `missBelow` above the threshold, or a `missAbove` under it, used to leave a
  pattern silently two-valued. It now throws `InvalidThresholdError`, as `band`
  and `is(label, { match, miss })` already did.
- **`between` checks its ends**, on probabilities and on ratings. A low end
  above the high end made a pattern that could never match, so a case built on
  it silently never fired. It now throws `InvalidRangeError`. Equal ends are
  allowed and match exactly that value or level.
- **`Eval.calibrate` requires at least one candidate in `values`**, typed as a
  non-empty tuple. An untyped caller passing `[]` gets a defect before any
  model call, rather than one after the sweep.
- **`Discern.ask` with an unscoped decision returns a defect instead of
  throwing.** The type already refuses it; an untyped caller now sees the
  failure when the Effect runs, as with any function that returns an Effect.

### Fixed

- **`replaying` and `caching` validate the answers they read back from a
  store.** Interceptors sit above `DecisionModel` validation, so a stored answer
  was handed to the policy as-is: a hand-edited recording with a probability of
  7, or a label the decision does not have, replayed as a confident answer.
  Stored answers now pass the same checks as a provider's, and a bad one fails
  with an `AiError` that `isInvalidObservation` recognises. Honest recordings
  replay exactly as before. Each check records a `DecisionModel.decide` span,
  so cache and replay hits now appear in traces.

### Documentation

- Ratings: `atLeast`, `atMost` and `between` compare a probability-weighted
  position that can fall between two levels, so `atLeast("major")` and
  `atMost("minor")` can both miss the same answer. The README and the method
  docs explain the gap and the ways to place it.
- New README sections on finite label sets, threshold and range validation,
  decoding a snapshot, and what replay checks.

## 0.4.0

Registries learned to ask less and report more.

### Added

- **`routeBy`** routes on a projection of the input rather than the whole of
  it. A procedure consumes the entire input; a router only needs enough to
  choose, so a diff, a document or a transcript no longer reaches the routing
  prompt. Because observations are content-addressed, the routing answer is now
  keyed on the projection — the same question about different evidence is a
  cache hit rather than a second call.
- **`eligible`** removes a procedure deterministically before the model sees
  the choices, on the same principle as `Discern.deterministic`
  short-circuiting a pattern. Narrowing to a single candidate skips the model
  entirely, reported as `Matched` with `by: "elimination"`.
- **`invokeWithRoute`** returns the routing decision next to the result, since
  in an agent the choice is often the interesting telemetry.
- `Registry.routeInput` exposes the schema the router actually sees.

### Changed

- **`Route` gained a `None` variant.** Eligibility ruling everything out is a
  deterministic fact, not uncertainty, so it is kept separate: `invoke` fails
  with `NoEligibleProcedureError` rather than `RoutingUncertainError`. An
  exhaustive `switch` over `Route` needs a new branch, and `None` carries no
  `ranked` list.
- `Matched` gained `by: "model" | "elimination"`.
- `Registry` gained a third type parameter for the routing input. It defaults
  to the registry's input, so uses that do not project are unaffected.
- `registry.decision` is typed by the projection, so evaluating a projected
  router uses the projected schema and projected examples.

### Documentation

- `Policy` was used throughout and never defined. There is now a section
  explaining that `Discern.type` starts a matcher, `orElse` finishes it into a
  callable `Policy`, and what hangs off one — and *matcher* is now reserved for
  one still being assembled.
- `classify`'s `{ match, miss, margin }` thresholds are explained, including
  that `miss` defaults to `match` and that `margin` only bites when `match` is
  low.
- Three-valued `and` / `or` are given truth tables.
- The opening example shows the whole stack, and a before/after against raw
  `Decision` replaces the abstract argument that preceded it. Both are
  typechecked as `examples/`.

## 0.3.0

First published release, as `@doeixd/discern`. The unscoped name `discern` on
npm belongs to an unrelated package from 2013.

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

- **Added** the `@doeixd/discern/procedure` entry point: `make`, `registry`, `route`,
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
