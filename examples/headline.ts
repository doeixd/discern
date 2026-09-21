/**
 * The README's opening example, kept here so it is typechecked.
 *
 * Only the import specifiers differ: inside this repository they point at
 * `../src`, where the README uses the published package name.
 */
import { Effect, Layer, Schema } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { TypeSafeClient, TypeSafeDecisionModel } from "@effect/ai-typesafe";
import * as Discern from "../src/index.js";
import * as Procedure from "../src/procedure.js";

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

const changes = Procedure.registry(Request, [reviewChange, explainChange]);

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

export const main = Effect.runPromise(Effect.provide(program, DecisionModelLayer));
