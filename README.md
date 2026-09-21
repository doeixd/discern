# discern

**Uncertainty-aware semantic pattern matching for Effect.**

Effect v4 has `Decision` / `DecisionModel`: provider-neutral semantic observations such as classification, probability and ordered rating. Discern turns those observations into **patterns and control flow**.

Think of it as the semantic counterpart to Effect `Match`:

```text
Predicate / Refinement  ->  Match
Decision / DecisionModel -> Discern
```

A normal pattern matches facts you can compute exactly. A Discern pattern matches **semantic evidence** produced by a `DecisionModel`.

```ts
import * as Discern from "discern"
import { Schema } from "effect"

const OnChange = Discern.on(Schema.String)

const impact = OnChange.classify({
  id: "api-impact",
  instructions: "Classify the public API impact",
  criteria: {
    none: "No public API impact",
    additive: "Adds API without changing existing behavior",
    behavioral: "Changes behavior of existing API",
    breaking: "Existing callers can break"
  }
})

const risky = OnChange.probability({
  id: "regression-risk",
  instructions: "This change is likely to cause a regression"
})

const review = Discern.type(Schema.String).pipe(
  Discern.when(
    Discern.and(
      impact.is("breaking"),
      risky.above(0.8, { missBelow: 0.5 })
    ),
    () => "block"
  ),
  Discern.when(impact.is("breaking"), () => "migration-required"),
  Discern.onUncertain(() => "human-review"),
  Discern.orElse(() => "ship")
)
```

`review(change)` is an `Effect` requiring an Effect `DecisionModel`.

## Status

Early and unstable (`0.2.x`). It targets Effect v4 release candidates and
`effect/unstable/ai`, so both the Effect APIs underneath it and Discern's own
surface can still change between minor versions.

## Install

Not yet published to npm. For now:

```bash
git clone https://github.com/doeixd/discern.git
cd discern
npm install
npm run check
```

`effect` is a peer dependency (`>=4.0.0-rc.116 <5`).

## Why not just `if (await model(...))`?

Because semantic evidence is not always boolean.

A model may say:

```text
P(risky) = 0.70
```

If your policy is:

```ts
risky.above(0.8, { missBelow: 0.5 })
```

Discern interprets that as:

```text
>= .80    Match
<= .50    Miss
.50-.80   Uncertain
```

That matters. This program:

```ts
Discern.type(Change).pipe(
  Discern.when(risky.above(0.8, { missBelow: 0.5 }), block),
  Discern.orElse(ship)
)
```

**does not ship when the model is merely uncertain.** It fails with `UncertainMatchError` unless you explicitly provide:

```ts
Discern.onUncertain(manualReview)
```

Discern treats uncertainty as a control-flow outcome instead of silently collapsing it into `false`.

## One observation, many patterns

A semantic decision is an observation. Patterns are deterministic views over that observation.

```ts
impact.is("breaking")
impact.is("behavioral")
impact.oneOf("behavioral", "breaking")
impact.margin("breaking", "behavioral", 0.2)
```

Using all four in the same matcher still classifies `impact` once.

Discern collects the unique decisions required by the matcher and batches them into one `DecisionModel.decide(...)` call.

```text
                       input
                         |
                         v
                 DecisionModel.decide
                    one model call
                         |
              +----------+----------+
              |                     |
           impact                  risk
       classify once          probability once
              |                     |
              +----------+----------+
                         |
                  Discern patterns
                         |
                 ordered handlers
```

## Input-aware decisions

Use `Discern.on(schema)` to bind decisions to an input type:

```ts
const OnTicket = Discern.on(Ticket)

const urgent = OnTicket.probability({
  id: "urgent",
  instructions: "This ticket needs immediate attention"
})
```

This gives `Discern.when(pattern, ticket => ...)` the correct handler input type and lets classification decisions participate in `Discern.match(...)`.

Unscoped `Discern.classify`, `Discern.probability` and `Discern.rate` also exist for lower-level composition.

## Semantic patterns

### Classification

```ts
const impact = OnChange.classify({
  id: "impact",
  instructions: "Classify API impact",
  criteria: {
    none: "No public API change",
    additive: "Adds API",
    behavioral: "Changes behavior",
    breaking: "Breaks callers"
  }
})

impact.is("breaking")
impact.oneOf("behavioral", "breaking")
impact.not("none")
impact.margin("breaking", "behavioral", 0.15)
```

Confidence-aware classification is tri-state:

```ts
impact.is("breaking", {
  match: 0.8,
  miss: 0.2,
  margin: 0.15
})
```

### Probability

```ts
const risk = OnChange.probability({
  id: "risk",
  instructions: "This change is risky"
})

risk.above(0.8)
risk.above(0.8, { missBelow: 0.5 })
risk.atLeast(0.8)
risk.below(0.2)
risk.between(0.4, 0.6)
risk.band({ match: 0.8, miss: 0.5 })
```

### Ordered ratings

```ts
const severity = OnChange.rate({
  id: "severity",
  instructions: "Rate compatibility severity",
  criteria: ["trivial", "minor", "major", "critical"] as const
})

severity.is("critical")
severity.atLeast("major")
severity.atMost("minor")
severity.between("minor", "major")
```

### Custom semantic refinement

```ts
const ambiguous = risk.whereResult(({ probability }) =>
  probability >= 0.4 && probability <= 0.6
    ? Discern.matched()
    : Discern.missed()
)
```

`where(...)` is the simpler boolean form. These are **semantic refinements**, not TypeScript `value is T` proofs.

## Pattern algebra

Discern uses three-valued logic:

```ts
Discern.and(a, b)
Discern.or(a, b)
Discern.not(a)
```

For `and`, `Miss` dominates and otherwise `Uncertain` dominates. For `or`, `Match` dominates and otherwise `Uncertain` dominates. `not` swaps `Match` / `Miss` and preserves `Uncertain`.

## Mix deterministic and semantic patterns

Do not ask a model something normal code already knows.

```ts
const sourceFile = Discern.deterministic(
  (path: string) => path.endsWith(".ts"),
  { id: "source-file" }
)

const riskySource = Discern.and(
  sourceFile,
  risk.above(0.8)
)
```

Discern partially evaluates deterministic structure before calling `DecisionModel`. If `sourceFile` is already false, the risk decision is unnecessary and no model call is made for that branch.

Aliases: `Discern.predicate` and `Discern.structural`.

## Exhaustive semantic classification

Arbitrary semantic predicates are not statically exhaustive. A single classification decision is different: its output is a known label union.

```ts
const handleImpact = Discern.match(impact).pipe(
  Discern.case("none", () => "ship"),
  Discern.case("additive", () => "docs"),
  Discern.case("behavioral", () => "review"),
  Discern.case("breaking", () => "migrate"),
  Discern.exhaustive
)
```

TypeScript rejects `Discern.exhaustive` until every classification label is handled.

This means “all model output labels are handled”, not “the model is metaphysically certain about the world”.

## Inspectable compiled plans

Matchers compile to a serializable semantic plan:

```ts
const matcher = Discern.type(Change).pipe(
  Discern.when(impact.is("breaking"), migrate, { id: "breaking" }),
  Discern.when(risk.above(0.8), review, { id: "risky" })
)

const plan = Discern.compile(matcher)
console.log(JSON.stringify(plan, null, 2))
```

`Discern.inspect` accepts either a matcher or an already-compiled plan, so
`Discern.inspect(matcher)` is the one-step form.

A plan includes:

- stable decision IDs
- decision fingerprints
- decision kinds and criteria
- ordered case IDs
- pattern ASTs
- a plan fingerprint

That makes semantic programs inspectable by devtools instead of hiding behavior in opaque prompts.

## Stable identity

Give production decisions stable IDs:

```ts
const risk = OnChange.probability({
  id: "regression-risk-v1",
  instructions: "This change is likely to regress production behavior"
})
```

Discern also fingerprints the actual decision definition. Reusing one ID for two different definitions in the same plan is rejected.

Without an explicit ID, Discern derives one from the decision definition.

## Observations, recording and replay

Every semantic observation in Discern funnels through one `DecisionModel` call.
So recording, replay, caching and budgets are not matcher features — they are
**decorators of the service**, and they apply to any Effect program that
reaches a `DecisionModel`, including code that never mentions Discern.

```ts
const observations = Discern.Model.store()

const model = anyDecisionModelLayer.pipe(
  Discern.Model.intercept([
    Discern.Model.recording(observations),
    Discern.Model.caching(observations),
    Discern.Model.budgeted(Discern.Model.budget({ decisions: 20 }))
  ])
)
```

`intercept` decorates *any* `DecisionModel` layer, including one from a provider
package you do not own. Interceptors are listed outermost-first, so above: the
recorder sees every answer, the cache is consulted next, and only genuine model
calls draw from the budget.

Observations are **content-addressed** by the decision definition together with
the encoded input:

```text
address = hash({ decision, state })
```

which has a few consequences worth knowing:

- A recording and a cache are the **same data structure**. There is no separate
  cache key to write, and no key function to get wrong.
- The same decision asked about two different inputs gets two entries, so one
  store can span many matchers and many inputs without collisions.
- If a decision's instructions or criteria change, its address changes, so a
  stale answer is simply absent rather than silently reused.

`Observations` are plain JSON. Snapshot them for a bug report or a regression
test:

```ts
const snapshot = observations.snapshot()
```

Replay reruns the program against those recorded answers and never reaches a
model:

```ts
const value = yield* review.replay(change, snapshot)
```

Handlers still execute. Replay removes semantic nondeterminism; it does not
memoize your Effect program, so side effects are not accidentally skipped.

Because replay is a layer, a program made of *several* policies plus ordinary
Effect code replays as a whole:

```ts
const program = (input: Change) =>
  Effect.gen(function* () {
    const risk = yield* riskPolicy(input)
    const urgency = yield* urgencyPolicy(input)
    return decide(risk, urgency)
  })

yield* program(change).pipe(
  Effect.provide(Discern.Model.replayLayer(snapshot))
)
```

Caching is partial for the same reason: a batch of four decisions with three
already known sends exactly one decision onward.

## Traces

A trace is separate, and answers a different question — not "what did the model
say?" but "what did this matcher *do* with it?"

```ts
const { value, trace } = yield* review.runWithTrace(change)
```

It records each evaluated case and its `Match | Miss | Uncertain` status, the
selected case or fallback, the plan fingerprint, and the raw answers by decision
id. Use it for diagnostics; use `Observations` to replay.

## Budgets

`budgeted` refuses model calls past a limit and reports what was spent:

```ts
const spend = Discern.Model.budget({ decisions: 20, calls: 4 })

// ... run the program under `Discern.Model.budgeted(spend)` ...

spend.spent() // => { decisions: 12, calls: 3 }
```

Failures cross the `DecisionModel` boundary as `AiError`, so Discern ships
predicates rather than asking you to match on shapes:

```ts
Discern.Model.isBudgetExceeded(error)
Discern.Model.isReplayMiss(error)
```

## Evaluation and calibration

Semantic thresholds should be tested, not chosen by vibes.

```ts
const examples = [
  { input: changeA, expected: true },
  { input: changeB, expected: false },
  { input: changeC, expected: true }
]

const report = yield* Discern.Eval.run(
  Change,
  risk.above(0.8, { missBelow: 0.5 }),
  examples
)
```

Reports include:

- accuracy
- selective accuracy
- precision / recall / F1
- uncertainty rate
- coverage
- confusion-matrix counts

Threshold sweeps reuse semantic observations:

```ts
const calibration = yield* Discern.Eval.calibrate({
  schema: Change,
  values: [0.5, 0.6, 0.7, 0.8, 0.9],
  pattern: threshold => risk.atLeast(threshold),
  examples,
  metric: "f1"
})

calibration.best
```

Discern asks the model once per example for the shared underlying decisions,
then evaluates every candidate threshold deterministically. Examples that
deterministic structure already settles cost no model call at all.

## Provider-neutral

Discern only depends on Effect `DecisionModel`.

For TypeSafe / Jev:

```bash
npm install discern effect @effect/ai-typesafe
```

```ts
import { Effect } from "effect"
import {
  TypeSafeClient,
  TypeSafeDecisionModel
} from "@effect/ai-typesafe"

const program = review(change).pipe(
  Effect.provide(TypeSafeDecisionModel.layer({ model: "jev-latest" })),
  Effect.provide(TypeSafeClient.layerConfig())
)
```

Any other Effect `DecisionModel` can run the same Discern program, and
`Discern.Model.intercept` decorates it without the provider package knowing:

```ts
const model = TypeSafeDecisionModel.layer({ model: "jev-latest" }).pipe(
  Discern.Model.intercept([Discern.Model.recording(observations)])
)
```

## Capabilities

`discern/capability` is a small layer above Discern: a **capability** is a
named, typed Effect program, and a **registry** picks between several of them
from a request.

```ts
import * as Capability from "discern/capability"

const find = Capability.make({
  id: "find",
  description: "Locate code relevant to a behavior, feature or concept",
  examples: ["Find where retries are implemented"],
  input: Request,
  run: request => findProgram(request)
})

const code = Capability.registry(Request, [find, review, testGaps])
```

When you know what you need, call it. No model is involved:

```ts
yield* find.run(request)
```

When you only know the intent, route:

```ts
yield* code.invoke(request)
```

### Routing is a decision, so uncertainty is a result

A registry compiles its members' descriptions into one classification. Routing
reads the **whole distribution**, not the provider's chosen label, and reports a
near-tie instead of resolving it:

```ts
const route = yield* code.route(request)

route._tag        // "Matched" | "Uncertain"
route.ranked      // every capability with its probability, best first
```

```text
find          .31
review        .34
test-gaps     .35
              ---
              Uncertain: no capability reached 0.7
```

That is the point. `find .31 / review .34 / test-gaps .35` is not a decision,
and `invoke` fails with `RoutingUncertainError` rather than running `test-gaps`
because it won by a hair. Handle it explicitly:

```ts
code.invoke(request, {
  routing: { minProbability: 0.7, minMargin: 0.15 },
  onUncertain: (request, route) => escalate(request, route.ranked)
})
```

### Routing can be measured

`registry.decision` is an ordinary Discern classification, so the router is a
pattern — and patterns can be evaluated:

```ts
const report = yield* Discern.Eval.run(
  Request,
  code.decision.is("find", { match: 0.7, margin: 0.15 }),
  labelledRequests
)

report.metrics.precision
report.metrics.uncertain
```

`Discern.Eval.calibrate` sweeps routing thresholds against one observation batch
per example, so you can tune `minProbability` without paying per candidate.

This matters more than it looks: a classification is a simplex, so **adding a
capability renormalizes every probability in the registry**. Thresholds
calibrated against an older membership do not carry over. Re-run the evaluation
when the registry changes.

### What routing does not do

`DecisionModel` answers are classifications, ratings and probabilities — there
is no structured generation. A registry can therefore **select** a capability
but never **parameterize** one.

So registries are homogeneous: every member accepts the registry's input type,
and that is enforced in the types. Capabilities with different inputs compose
the ordinary way, as Effect code:

```ts
const dependencyReview = Capability.make({
  id: "dependency-review",
  description: "Assess the risk of upgrading a dependency",
  input: UpgradeRequest,
  run: request =>
    Effect.gen(function* () {
      const usages = yield* find.run({ query: `Usages of ${request.package}` })
      return yield* compatibility.run({ package: request.package, usages })
    })
})
```

Static composition where you know the shape; routing only where you genuinely
do not. This is also why Discern is a router and a policy engine rather than a
tool-calling agent: the model picks, your code constructs.

### Execution trees

`Capability.make` wraps `run` in a named scope, so a recording knows which
capability made each observation:

```ts
const observations = Discern.Model.store()
// ... run under Discern.Model.recording(observations) ...

Discern.Model.tree(observations.snapshot())
```

```text
invoke
├─ route            the registry classification
└─ audit            the capability that was chosen
   └─ risk          a decision it made internally
```

An observation is content-addressed, so one entry covers every place the same
decision was asked about the same input, and its scope is wherever it was used
most recently. Record each run into its own store when you want a faithful
per-run tree.

`Discern.Model.scope("name")` is the underlying primitive and works on any
Effect, so you can nest by your own concepts rather than only by capability.

Because replay is a layer, an entire `invoke` — the routing decision *and*
everything the chosen capability did — replays from one recording.

## Mental model

Discern separates the layers:

```text
Effect         execution, services, errors, concurrency
DecisionModel  who produces a semantic observation
Interceptor    recording, replay, caching, budgets
Decision       what observation should be made
Pattern        how the evidence should be interpreted
Policy         which ordered branch runs
Capability     a named program the system knows how to do
Registry       which capability a request belongs to
```

Or, more compactly:

```text
Effect Match = control flow over facts
Discern      = control flow over uncertain semantic observations
```

That makes Discern a useful base for higher-level Effect capabilities / Stanley-style workflows without making Discern itself a workflow framework.

## License

MIT
