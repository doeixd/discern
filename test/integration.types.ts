/**
 * Compile-only proof that the documented provider wiring actually works.
 *
 * This is never executed and needs no API key — it exists so the integration in
 * the README cannot drift from the packages it describes.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { TypeSafeClient, TypeSafeDecisionModel } from "@effect/ai-typesafe";
import * as Discern from "../src/index.js";
import * as Procedure from "../src/procedure.js";

const Change = Schema.String;
const OnChange = Discern.on(Change);

const risky = OnChange.probability({
  id: "regression-risk",
  instructions: "This change is likely to cause a regression",
});

const review = Discern.type(Change).pipe(
  Discern.when(risky.above(0.8, { missBelow: 0.5 }), () => "block"),
  Discern.onUncertain(() => "human-review"),
  Discern.orElse(() => "ship"),
);

// A DecisionModel layer with every requirement satisfied.
const observations = Discern.Model.store();
const DecisionModelLayer = TypeSafeDecisionModel.layer({ model: "jev-latest" }).pipe(
  Discern.Model.intercept([Discern.Model.recording(observations)]),
  Layer.provide(TypeSafeClient.layerConfig()),
  Layer.provide(FetchHttpClient.layer),
);

// A policy, fully provided, requires nothing further.
const runnable: Effect.Effect<string, unknown, never> = review("a change").pipe(
  Effect.provide(DecisionModelLayer),
);
void runnable;

// A procedure registry over the same provider.
const check = Procedure.make({
  id: "check",
  description: "Review a change for regression risk",
  input: Change,
  run: review,
});
const ship = Procedure.make({
  id: "ship",
  description: "Release a change that has already been reviewed",
  input: Change,
  run: (change: string) => Effect.succeed(`shipping ${change}`),
});
const registry = Procedure.registry(Change, [check, ship]);

const routed: Effect.Effect<string, unknown, never> = registry
  .invoke("a change")
  .pipe(Effect.provide(DecisionModelLayer));
void routed;
