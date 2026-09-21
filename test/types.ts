import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Discern from "../src/index.js";

const Change = Discern.on(Schema.String);

const impact = Change.classify({
  id: "impact",
  instructions: "Classify API impact",
  criteria: {
    none: "none",
    additive: "additive",
    behavioral: "behavioral",
    breaking: "breaking",
  },
});

impact.is("breaking");
impact.is("breaking", { match: 0.8, miss: 0.2, margin: 0.1 });
// @ts-expect-error unknown labels are rejected
impact.is("critical");

const risky = Change.probability({ instructions: "Likely to regress" });
const severe = Change.rate({
  instructions: "Rate severity",
  criteria: ["low", "medium", "high"] as const,
});

const matcher = Discern.type(Schema.String).pipe(
  Discern.when(
    Discern.and(impact.is("breaking"), risky.above(0.8, { missBelow: 0.5 })),
    (input) => input.toUpperCase(),
  ),
  Discern.when(severe.atLeast("medium"), (input) => Effect.succeed(input.length)),
  Discern.onUncertain((input: string) => `review:${input}`),
  Discern.orElse((input) => input.length > 0),
);

const result = matcher("change");
void result;
void matcher.plan;
void matcher.runWithTrace("change");

const exhaustive = Discern.match(impact).pipe(
  Discern.case("none", () => 0),
  Discern.case("additive", () => 1),
  Discern.case("behavioral", () => 2),
  Discern.case("breaking", () => 3),
  Discern.exhaustive,
);
void exhaustive("change");

const incomplete = Discern.match(impact).pipe(
  Discern.case("none", () => 0),
  Discern.case("additive", () => 1),
);
// @ts-expect-error exhaustive is unavailable until all labels are handled
Discern.exhaustive(incomplete);

const immediate = Discern.value(Schema.String, "change").pipe(
  Discern.when(impact.is("breaking"), (input) => input.toUpperCase()),
  Discern.orElse((input) => input),
);
void immediate;

// --- DecisionModel middleware -------------------------------------------------

const observations = Discern.Model.store();
const spend = Discern.Model.budget({ decisions: 20, calls: 4 });

void Discern.Model.layer(Discern.Model.unavailable, [
  Discern.Model.recording(observations),
  Discern.Model.caching(observations),
  Discern.Model.budgeted(spend),
]);

void Discern.Model.replayLayer(observations.snapshot());

// Replay accepts either a snapshot or a live store, and drops DecisionModel from R.
void matcher.replay("change", observations.snapshot());
void matcher.replay("change", observations);

const asPolicy: Discern.Policy<string, string | number | boolean, never, never, typeof Schema.String> = matcher;
void asPolicy;

// --- Capabilities -------------------------------------------------------------

import * as Capability from "../src/capability.js";

const Request = Schema.String;

const findCap = Capability.make({
  id: "find",
  description: "Locate relevant code",
  input: Request,
  run: (request: string) => Effect.succeed(request.length),
});

const reviewCap = Capability.make({
  id: "review",
  description: "Review a change",
  input: Request,
  run: () => Effect.succeed("reviewed" as const),
});

// Ids stay literal, so `get` is checked against actual membership.
const code = Capability.registry(Request, [findCap, reviewCap]);
const foundCap: typeof findCap = code.get("find");
void foundCap;
// @ts-expect-error there is no such capability in this registry
code.get("test-gaps");

// invoke unions the member outputs.
const invoked: Effect.Effect<number | "reviewed", unknown, unknown> = code.invoke("x");
void invoked;

// A fallback widens the success type rather than being swallowed.
const withFallback: Effect.Effect<number | "reviewed" | "escalated", unknown, unknown> = code.invoke("x", {
  onUncertain: () => "escalated" as const,
});
void withFallback;

// Routing carries the full ranking, keyed by the registry's own ids.
void code.route("x").pipe(
  Effect.map((route) => (route._tag === "Matched" ? route.id : route.ranked[0]!.id)),
);

// Registries are homogeneous in input: a capability over a different schema is rejected.
const numeric = Capability.make({
  id: "numeric",
  description: "Takes a number",
  input: Schema.Number,
  run: (value: number) => Effect.succeed(value),
});
// @ts-expect-error `numeric` does not accept the registry's input type
Capability.registry(Request, [findCap, numeric]);

// A Budget carries a private brand, so only `Discern.Model.budget` can make one.
// @ts-expect-error a hand-rolled budget would fail at runtime on a private hook
const handRolled: Discern.Model.Budget = {
  limits: { decisions: 1 },
  spent: () => ({ decisions: 0, calls: 0 }),
  reset: () => {},
};
void handRolled;
