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
