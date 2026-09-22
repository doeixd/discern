# Discern

**Uncertainty-aware, smart semantic control flow and procedures for Effect.**

Type-safe patterns, policies and routable procedures over Effect's `Decision`
and `DecisionModel` — where *maybe* is a branch you handle, not a rounding
error. Provider-neutral: runs on TypeSafe's Jev, or any other `DecisionModel`.

[![Silent tutorial trailer: one beat from each chapter, following a code change from a Jev judgment through Decision, DecisionModel, Discern patterns, policies and procedure registries. Click to watch the full explanation.](https://raw.githubusercontent.com/doeixd/discern/main/docs/assets/discern-explainer-silent.gif)](https://github.com/doeixd/discern/blob/main/docs/assets/discern-explainer-silent.mp4)

[Watch the full tutorial](https://github.com/doeixd/discern/blob/main/docs/assets/discern-explainer-silent.mp4) — 2:44, silent, with on-screen explanations.

Follow one code change through **Jev → Effect Decision / DecisionModel →
Discern → Procedures → nested registries**. 

Effect v4 has `Decision` / `DecisionModel`: provider-neutral semantic
observations such as classification, probability and ordered rating — a model
judging something, in a typed and batched form.

Think of it as the semantic counterpart to Effect `Match`:

```text
Predicate / Refinement  ->  Match
Decision / DecisionModel -> Discern
```

A normal pattern matches facts you can compute exactly. A Discern pattern
matches **semantic evidence** produced by a `DecisionModel`.

Here is the whole stack — Effect's `Decision` vocabulary, a policy,
procedures, and a real provider:

```ts
import { Effect, Layer, Schema } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { TypeSafeClient, TypeSafeDecisionModel } from "@effect/ai-typesafe";
import * as Discern from "@doeixd/discern";
import * as Procedure from "@doeixd/discern/procedure";

// --- decisions: what the model is asked, via Effect's Decision vocabulary ---

const Change = Schema.Struct({
  id: Schema.String,
  summary: Schema.String,
  diff: Schema.String,
});

const OnChange = Discern.on(Change);

const impact = OnChange.classify({
  id: "api-impact",
  instructions: "Classify the public API impact of this change",
  criteria: {
    none: "No public API impact",
    additive: "Adds API without changing existing behavior",
    behavioral: "Changes behavior of existing API",
    breaking: "Existing callers can break",
  },
});

const risky = OnChange.probability({
  id: "regression-risk",
  instructions: "This change is likely to cause a regression",
});

// --- a policy: ordered rules over that evidence, uncertainty included ---

const review = Discern.type(Change).pipe(
  Discern.when(
    Discern.and(impact.is("breaking"), risky.above(0.8, { missBelow: 0.5 })),
    () => "block" as const,
  ),
  Discern.when(impact.is("breaking"), () => "migration-required" as const),
  Discern.onUncertain(() => "human-review" as const),
  Discern.orElse(() => "ship" as const),
);

// Both decisions are answered in one DecisionModel call, however many cases
// refer to them. `review(change)` is an Effect requiring a DecisionModel.

// --- procedures: named programs a request can be routed to ---

// Routing selects but never constructs, so the request carries the intent.
const Request = Schema.Struct({ ask: Schema.String, change: Change });

const reviewChange = Procedure.make({
  id: "review",
  description: "Judge whether a change is safe to release",
  examples: ["Is this safe to ship?", "Will this break callers?"],
  input: Request,
  run: (request) => review(request.change),
});

const explainChange = Procedure.make({
  id: "explain",
  description: "Summarise in plain language what a change does",
  examples: ["What does this do?", "Explain this diff"],
  input: Request,
  run: (request) => Effect.succeed(request.change.summary),
});

// The router only needs the intent, so the diff never reaches the routing
// prompt — fewer tokens, better signal, and the routing answer is cached per
// question rather than per question-and-diff.
const changes = Procedure.registry(Request, [reviewChange, explainChange], {
  routeBy: { schema: Schema.String, select: (request) => request.ask },
});

// --- the provider: any Effect DecisionModel, here TypeSafe / Jev ---

const DecisionModelLayer = TypeSafeDecisionModel.layer({ model: "jev-latest" }).pipe(
  Layer.provide(TypeSafeClient.layerConfig()),
  Layer.provide(FetchHttpClient.layer),
);

const program = Effect.gen(function* () {
  const change = { id: "PR-42", summary: "Drop the deprecated retry field", diff: "..." };

  // Call a procedure directly when you already know which one you want.
  const verdict = yield* reviewChange.run({ ask: "is this safe?", change });

  // Or let the request choose — and say so when it cannot choose confidently.
  const answer = yield* changes.invoke(
    { ask: "what does this do?", change },
    { onUncertain: (_request, route) => `ask a human — closest was ${route.ranked[0]!.id}` },
  );

  return { verdict, answer };
});

Effect.runPromise(Effect.provide(program, DecisionModelLayer));
```

Three things are worth noticing.

`review(change)` asks **one** `DecisionModel` call per change, however many
cases refer to `impact` and `risky`. Discern collects the distinct decisions a
policy needs and batches them.

**A 0.62 risk never reaches `ship`.** It is neither above `0.8` nor below
`missBelow: 0.5`, so it is not a miss — the program takes `onUncertain`
instead of quietly rounding the evidence down to false.

And `changes.invoke(...)` reports what it cannot decide. A request that splits
`.48 / .52` between two procedures is not a decision, so it goes to
`onUncertain` rather than to whichever won by a hair.

This example is compiled as `examples/headline.ts`, so it cannot drift from
the library or from the provider packages.

## Contents

- [Status](#status) · [Install](#install)
- **Why** — [Why not `Decision` directly?](#why-not-decision-directly)
- **Programs** — [Policies](#policies)
- **Patterns** — [One observation, many patterns](#one-observation-many-patterns) ·
  [Input-aware decisions](#input-aware-decisions) · [Semantic
  patterns](#semantic-patterns) · [Pattern algebra](#pattern-algebra) · [Mix
  deterministic and semantic](#mix-deterministic-and-semantic-patterns) ·
  [Exhaustive classification](#exhaustive-semantic-classification)
- **Inspection** — [Compiled plans](#inspectable-compiled-plans) ·
  [Stable identity](#stable-identity) · [Traces](#traces)
- **Running it** — [Observations, recording and replay](#observations-recording-and-replay) ·
  [Budgets](#budgets) · [Evaluation and
  calibration](#evaluation-and-calibration) ·
  [Provider-neutral](#provider-neutral)
- **Routing** — [Procedures](#procedures) ·
  [Route projection](#route-on-only-what-the-router-needs) ·
  [Eligibility](#rule-procedures-out-before-asking)
- [Mental model](#mental-model) · [License](#license)

## Status

Early and unstable (`0.3.x`). It targets Effect v4 release candidates and
`effect/unstable/ai`, so both the Effect APIs underneath it and Discern's own
surface can still change between minor versions.

## Install

```bash
npm install @doeixd/discern effect@rc
```

`effect` is a peer dependency (`>=4.0.0-rc.116 <5`). Note that `effect@latest`
is still 3.x, so v4 has to be asked for by tag — installing plain `effect`
gets you a major version this will not work with.

The unscoped name `discern` on npm belongs to an unrelated 2013 package, which
is why this one is scoped. The library still calls itself Discern everywhere
else.

To work on it locally:

```bash
git clone https://github.com/doeixd/discern.git
cd discern
npm install
npm run check
npm run example
```

There is a runnable tour in `examples/walkthrough.mjs`:

```bash
npm run example
```

It uses a stub provider, so it is deterministic and costs nothing, and it
exercises uncertainty, recording, replay, budgets and routing end to end.

## Why not `Decision` directly?

Effect already gives you everything you need to ask a model a question. Here
is the policy from above written straight against `Decision` and
`DecisionModel`:

```ts
import { Effect, Schema } from "effect"
import * as Decision from "effect/unstable/ai/Decision"
import * as DecisionModel from "effect/unstable/ai/DecisionModel"

const ChangeReview = Decision.make({
  input: Change,
  decisions: {
    impact: Decision.classify({
      instructions: "Classify the public API impact of this change",
      criteria: {
        none: "No public API impact",
        additive: "Adds API without changing existing behavior",
        behavioral: "Changes behavior of existing API",
        breaking: "Existing callers can break",
      },
    }),
    risk: Decision.probability({
      instructions: "This change is likely to cause a regression",
    }),
  },
});

const reviewRaw = (change: typeof Change.Type) =>
  Effect.gen(function* () {
    const { answers } = yield* DecisionModel.decide(ChangeReview, { input: change });

    if (answers.impact.label === "breaking" && answers.risk.probability > 0.8) {
      return "block";
    }
    if (answers.impact.label === "breaking") {
      return "migration-required";
    }
    return "ship";
  });
```

That is reasonable code, and where the branching really is boolean it is the
right amount of machinery. Here is the same policy in Discern:

```ts
import * as Discern from "@doeixd/discern"

const OnChange = Discern.on(Change);

const impact = OnChange.classify({
  id: "api-impact",
  instructions: "Classify the public API impact of this change",
  criteria: {
    none: "No public API impact",
    additive: "Adds API without changing existing behavior",
    behavioral: "Changes behavior of existing API",
    breaking: "Existing callers can break",
  },
});

const risky = OnChange.probability({
  id: "regression-risk",
  instructions: "This change is likely to cause a regression",
});

const review = Discern.type(Change).pipe(
  Discern.when(
    Discern.and(impact.is("breaking"), risky.above(0.8, { missBelow: 0.5 })),
    () => "block" as const,
  ),
  Discern.when(impact.is("breaking"), () => "migration-required" as const),
  Discern.onUncertain(() => "human-review" as const),
  Discern.orElse(() => "ship" as const),
);
```

The difference is not line count. It is four things the first version does
quietly.

**A 0.62 risk ships.** `answers.risk.probability > 0.8` is false at 0.62, so
the change falls through to `ship`. The model said *maybe* and the program
heard *no*. The second version sends it to `onUncertain`, because `above(0.8,
{ missBelow: 0.5 })` describes three outcomes rather than two:

```text
>= .80    Match
<= .50    Miss
.50-.80   Uncertain
```

Leave out `onUncertain` and it fails with `UncertainMatchError` instead —
never silently.

**`answers.impact.label` is treated as fact.** Effect's own documentation notes
that the label "is chosen by the provider and need not have the highest
probability", so a `.34 / .33 / .33` classification reads exactly like a `.95`
one. `impact.is("breaking", { match: 0.8, margin: 0.15 })` states the
confidence you actually require.

**The decision set and the branching drift apart.** In the first version the
`decisions` record and the `if` chain are maintained separately: adding a rule
means editing both, and a decision no branch reads any more stays in the batch
and is still paid for. In the second the decisions *are* whatever the patterns
refer to — and a deterministic guard that already settles a case drops its
decisions from the request for that input.

**There is nothing to inspect or reuse.** No compiled plan, no trace, and no
content-addressed observations — so no replay, no cache, no budget, and no way
to find out whether `0.8` was the right number in the first place. A pattern
is a value, so `Discern.Eval.calibrate` can sweep thresholds over labelled
examples and let the data choose.

Both halves are compiled as `examples/comparison.ts`.

## Policies

The pattern sections below build the *evidence*. A **policy** is what runs on
it.

`Discern.type(schema)` starts a matcher, `Discern.when` adds ordered cases,
and `Discern.orElse` finishes it — turning the matcher into a callable
**`Policy`**:

```ts
const review = Discern.type(Change).pipe(
  Discern.when(impact.is("breaking"), () => "migrate"),
  Discern.onUncertain(() => "human-review"),
  Discern.orElse(() => "ship")
)
```

That is why `review(change)` is callable at all. It returns an `Effect`
requiring a `DecisionModel`, and it carries three more things:

```ts
review(change)                      // Effect<Verdict, …, DecisionModel>
review.plan                         // the compiled, serializable plan
review.runWithTrace(change)         // { value, trace }
review.replay(change, observations) // rerun from a recording, without a model
```

There are two spellings, deliberately:

- `Discern.type(schema)` builds a **reusable** policy you call many times.
- `Discern.value(schema, input)` matches **one value** immediately, so `orElse`
  hands back the `Effect` itself rather than something callable.

For the rest of this README, *matcher* means one still being assembled and
*policy* means a finished one.

## One observation, many patterns

A semantic decision is an observation. Patterns are deterministic views over
that observation.

```ts
impact.is("breaking")
impact.is("behavioral")
impact.oneOf("behavioral", "breaking")
impact.margin("breaking", "behavioral", 0.2) // P(breaking) - P(behavioral) >= 0.2
```

Using all four in the same policy still classifies `impact` once.

Discern collects the unique decisions a policy requires and batches them into
one `DecisionModel.decide(...)` call.

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

This gives `Discern.when(pattern, ticket => ...)` the correct handler input
type and lets classification decisions participate in `Discern.match(...)`.

`Discern.classify`, `Discern.probability` and `Discern.rate` also exist
without a schema, for lower-level composition.

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
impact.margin("breaking", "behavioral", 0.15) // breaking leads behavioral by >= 0.15
```

`impact.is("breaking")` on its own takes the provider's chosen label at face
value. Give it thresholds and it becomes tri-state, like a probability:

```ts
impact.is("breaking", {
  match: 0.8,   // P(breaking) at or above this is a Match
  miss: 0.2,    // at or below this is a Miss — in between is Uncertain
  margin: 0.15  // and it must lead the runner-up label by at least this much
})
```

`match` defaults to `0.8`, and `miss` defaults to whatever `match` is — so
omitting `miss` leaves no uncertain band at all.

`margin` only bites when `match` is low. A label sitting at `0.8` already
leads everything else by at least `0.6`, because the distribution sums to one;
it is at `0.45` that the runner-up might be right behind it.

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

`where` interprets an answer as a boolean:

```ts
const borderline = risk.where(
  ({ probability }) => probability >= 0.4 && probability <= 0.6
)
```

`whereResult` is the same thing with uncertainty available, for when two
outcomes are not enough:

```ts
const ambiguous = risk.whereResult(({ probability }) =>
  probability > 0.6 ? Discern.missed()
  : probability >= 0.4 ? Discern.uncertain("too close to call")
  : Discern.matched()
)
```

Both are **semantic refinements**, not TypeScript `value is T` proofs.

## Pattern algebra

Discern uses three-valued logic:

```ts
Discern.and(a, b)
Discern.or(a, b)
Discern.not(a)
```

In `and`, `Miss` dominates; otherwise `Uncertain` does:

| `and` | Match | Uncertain | Miss |
| --- | --- | --- | --- |
| **Match** | Match | Uncertain | Miss |
| **Uncertain** | Uncertain | Uncertain | Miss |
| **Miss** | Miss | Miss | Miss |

In `or`, `Match` dominates; otherwise `Uncertain` does:

| `or` | Match | Uncertain | Miss |
| --- | --- | --- | --- |
| **Match** | Match | Match | Match |
| **Uncertain** | Match | Uncertain | Uncertain |
| **Miss** | Match | Uncertain | Miss |

`not` swaps `Match` and `Miss`, and leaves `Uncertain` alone.

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

Discern partially evaluates deterministic structure before calling
`DecisionModel`. If `sourceFile` is already false, the risk decision is
unnecessary and no model call is made for that branch.

Aliases: `Discern.predicate` and `Discern.structural`.

## Exhaustive semantic classification

Arbitrary semantic predicates are not statically exhaustive. A single
classification decision is different: its output is a known label union.

```ts
const handleImpact = Discern.match(impact).pipe(
  Discern.case("none", () => "ship"),
  Discern.case("additive", () => "docs"),
  Discern.case("behavioral", () => "review"),
  Discern.case("breaking", () => "migrate"),
  Discern.exhaustive
)
```

TypeScript rejects `Discern.exhaustive` until every classification label is
handled.

This means “all model output labels are handled”, not “the model is
metaphysically certain about the world”.

## Inspectable compiled plans

A policy compiles to a serializable semantic plan. So does an unfinished
matcher, which is why you can inspect one before choosing a fallback:

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

That makes semantic programs inspectable by devtools instead of hiding
behavior in opaque prompts.

## Stable identity

Give production decisions stable IDs:

```ts
const risk = OnChange.probability({
  id: "regression-risk-v1",
  instructions: "This change is likely to regress production behavior"
})
```

Discern also fingerprints the actual decision definition. Reusing one ID for
two different definitions in the same plan is rejected.

Without an explicit ID, Discern derives one from the decision definition.

## Observations, recording and replay

Every semantic observation in Discern funnels through one `DecisionModel`
call. So recording, replay, caching and budgets are not policy features — they
are
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

`intercept` decorates *any* `DecisionModel` layer, including one from a
provider package you do not own. Interceptors are listed outermost-first, so
above: the recorder sees every answer, the cache is consulted next, and only
genuine model calls draw from the budget.

Observations are **content-addressed** by the decision definition together
with the encoded input:

```text
address = hash({ decision, state })
```

which has a few consequences worth knowing:

- A recording and a cache are the **same data structure**. There is no separate
  cache key to write, and no key function to get wrong.
- The same decision asked about two different inputs gets two entries, so one
  store can span many policies and many inputs without collisions.
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
Effect code replays as a whole. Given two independent policies over the same
input — say `riskPolicy` and `urgencyPolicy`, each built exactly like `review`
above:

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

Caching works decision by decision for the same reason — an address covers one
decision, not a whole batch — so four decisions with three already known send
exactly one onward.

## Traces

A trace is separate, and answers a different question — not "what did the
model say?" but "what did this policy *do* with it?"

```ts
const { value, trace } = yield* review.runWithTrace(change)
```

It records each evaluated case and its `Match | Miss | Uncertain` status, the
selected case or fallback, the plan fingerprint, and the raw answers by
decision id. Use it for diagnostics; use `Observations` to replay.

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

For TypeSafe / Jev. Both packages publish v4 under the `rc` tag — their
`latest` is a 3.x release and a placeholder respectively, so neither works
without it:

```bash
npm install effect@rc @effect/ai-typesafe@rc
```

`TypeSafeClient` needs an `HttpClient`, so the stack is three layers deep:

```ts
import { Effect, Layer } from "effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { TypeSafeClient, TypeSafeDecisionModel } from "@effect/ai-typesafe"

const DecisionModelLayer = TypeSafeDecisionModel.layer({ model: "jev-latest" }).pipe(
  Layer.provide(TypeSafeClient.layerConfig()),
  Layer.provide(FetchHttpClient.layer)
)

const program = review(change).pipe(Effect.provide(DecisionModelLayer))
```

`test/integration.types.ts` compiles exactly this wiring against the real
packages, so the snippet above cannot drift from them.

Any other Effect `DecisionModel` can run the same Discern program, and
`Discern.Model.intercept` decorates it without the provider package knowing:

```ts
const model = TypeSafeDecisionModel.layer({ model: "jev-latest" }).pipe(
  Discern.Model.intercept([Discern.Model.recording(observations)])
)
```

## Procedures

`@doeixd/discern/procedure` is a small layer above Discern: a **procedure** is
a named, typed Effect program, and a **registry** picks between several of
them from a request.

```ts
import * as Procedure from "@doeixd/discern/procedure"

const find = Procedure.make({
  id: "find",
  description: "Locate code relevant to a behavior, feature or concept",
  examples: ["Find where retries are implemented"],
  input: Request,
  run: request => findProgram(request)
})

const code = Procedure.registry(Request, [find, review, testGaps])
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
reads the **whole distribution**, not the provider's chosen label, and reports
a near-tie instead of resolving it:

```ts
const route = yield* code.route(request)

route._tag        // "Matched" | "Uncertain"
route.ranked      // every procedure with its probability, best first
```

```text
find          .31
review        .34
test-gaps     .35
              ---
              Uncertain: no procedure reached 0.7
```

That is the point. `find .31 / review .34 / test-gaps .35` is not a decision,
and `invoke` fails with `RoutingUncertainError` rather than running
`test-gaps` because it won by a hair. Handle it explicitly:

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

`Discern.Eval.calibrate` sweeps routing thresholds against one observation
batch per example, so you can tune `minProbability` without paying per
candidate.

This matters more than it looks: a classification is a simplex, so **adding a
procedure renormalizes every probability in the registry**. Thresholds
calibrated against an older membership do not carry over. Re-run the
evaluation when the registry changes.

### What routing does not do

`DecisionModel` answers are classifications, ratings and probabilities — there
is no structured generation. A registry can therefore **select** a procedure
but never **parameterize** one.

So registries are homogeneous: every member accepts the registry's input type,
and that is enforced in the types. Procedures with different inputs compose
the ordinary way, as Effect code:

```ts
const dependencyReview = Procedure.make({
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

### Route on only what the router needs

A procedure consumes the whole input. A router only needs enough of it to
choose. Without saying so, a registry sends the entire input to the model —
including a diff, a document or a transcript that has no bearing on which
procedure applies.

```ts
const changes = Procedure.registry(Request, [reviewChange, explainChange], {
  routeBy: { schema: Schema.String, select: request => request.ask }
})
```

```text
full typed input ──────────────────────► chosen procedure
       │
       ▼
  select(request)
       │
       ▼
 "what does this do?" ─────────────────► routing decision
```

Fewer tokens and better signal, and because observations are content-addressed
the routing answer is now keyed on the question alone — the same question
about a different diff reuses it instead of paying again.

`registry.decision` is typed by the projection, so evaluating the router uses
the projected schema and projected examples.

### Rule procedures out before asking

Semantic routing should not be offered choices ordinary code has already
eliminated — the same principle as `Discern.deterministic` short-circuiting a
pattern.

```ts
const deploy = Procedure.make({
  id: "deploy",
  description: "Release the change described by a ticket",
  input: Ticket,
  eligible: ticket => ticket.environment !== "local",
  run: releaseProgram
})
```

```text
all procedures
      ↓  deterministic eligibility
possible procedures
      ↓  semantic classification
    chosen
```

Two consequences fall out. Narrowing to a **single** candidate skips the model
entirely — the route comes back `Matched` with `by: "elimination"`. Narrowing
to **none** is not uncertainty but a deterministic fact, so it is its own
outcome:

```ts
route._tag // "Matched" | "Uncertain" | "None"
```

`invoke` fails with `NoEligibleProcedureError` on `None`, separately from
`RoutingUncertainError`, because "nothing applies" and "I cannot tell these
apart" are different problems with different fixes.

### The route is telemetry

In an agent or a workflow the choice is often as interesting as the result:

```ts
const { route, value } = yield* changes.invokeWithRoute(request)

route.id          // which procedure ran
route.probability // how sure the model was
route.margin      // how far ahead of the runner-up
route.by          // "model", or "elimination" if it cost nothing
route.ranked      // every candidate that was considered
```

### Registries nest

A flat classification gets vague past roughly eight members: the criteria grow
into a long prompt and the probabilities spread thin. A registry can be
presented as a procedure, so grouping is just membership:

```ts
const codeGroup = Procedure.registry(Request, [find, review, testGaps])

const code = Procedure.fromRegistry({
  id: "code",
  description: "Anything about reading or reviewing source code",
  registry: codeGroup
})

const top = Procedure.registry(Request, [code, lint, deploy])
```

Each level is a short, sharp question rather than one wide one.

Because a procedure can route, routing can recurse. `invoke` counts nesting
depth and refuses past a ceiling:

```ts
program.pipe(Procedure.withMaxDepth(4))
```

The default is 8, and a program that reaches it fails with
`DepthExceededError`. Only `invoke` is counted — a procedure calling another
procedure's `run` directly is bounded by the code that does it.

### Execution trees

`Procedure.make` wraps `run` in a named scope, so a recording knows which
procedure made each observation:

```ts
const observations = Discern.Model.store()
// ... run under Discern.Model.recording(observations) ...

Discern.Model.tree(observations.snapshot())
```

```text
invoke
├─ route            the registry classification
└─ audit            the procedure that was chosen
   └─ risk          a decision it made internally
```

An observation is content-addressed, so one entry covers every place the same
decision was asked about the same input, and its scope is wherever it was used
most recently. Record each run into its own store when you want a faithful
per-run tree.

`Discern.Model.region("name")` is the underlying primitive and works on any
Effect, so you can nest by your own concepts rather than only by procedure. It
is not called a scope because Effect's `Scope` is about resource lifetime;
this is only about attribution.

Because replay is a layer, an entire `invoke` — the routing decision *and*
everything the chosen procedure did — replays from one recording.

## Mental model

Discern separates the layers:

```text
Effect         execution, services, errors, concurrency
DecisionModel  who produces a semantic observation
Interceptor    recording, replay, caching, budgets
Decision       what observation should be made
Pattern        how the evidence should be interpreted
Policy         which ordered branch runs
Procedure      a named, described, typed entry point
Registry       which procedure a request belongs to
```

Or, more compactly:

```text
Effect Match = control flow over facts
Discern      = control flow over uncertain semantic observations
```

That makes Discern a useful base for higher-level Effect procedures /
Stanley-style workflows without making Discern itself a workflow framework.

## License

MIT
