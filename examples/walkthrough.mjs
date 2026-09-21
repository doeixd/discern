/**
 * A runnable tour of discern. `node examples/walkthrough.mjs` (after `npm run build`).
 *
 * There is no real provider here. `stubModel` stands in for a DecisionModel,
 * answering from a fixed table so the output is deterministic and the example
 * costs nothing. Swap it for a real `DecisionModel` layer and everything below
 * works unchanged — that is the point of the provider-neutral boundary.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Discern from "../dist/index.js";
import * as Procedure from "../dist/procedure.js";

const { Model } = Discern;

// --- a stand-in for a real model ---------------------------------------------

/** What our pretend model believes about each change. */
const beliefs = {
  "rename a public export": { impact: "breaking", risk: 0.35 },
  "tweak an internal helper": { impact: "none", risk: 0.05 },
  "loosen a retry timeout": { impact: "behavioral", risk: 0.62 },
  "drop a deprecated field": { impact: "breaking", risk: 0.91 },
};

const spread = (labels, winner) =>
  Object.fromEntries(
    labels.map((label) => [label, label === winner ? 0.85 : 0.15 / (labels.length - 1)]),
  );

let modelCalls = 0;
const stubModel = Model.provider((options) =>
  Effect.sync(() => {
    modelCalls += 1;
    const belief = beliefs[options.state] ?? { impact: "none", risk: 0.5 };
    const answers = {};
    for (const [id, decision] of Object.entries(options.decisions)) {
      if (decision._tag === "Probability") {
        answers[id] = { _tag: "Probability", probability: belief.risk };
      } else {
        const labels = Object.keys(decision.criteria);
        // Routing decisions are classifications too; pick by keyword.
        const winner = labels.includes(belief.impact)
          ? belief.impact
          : labels.find((label) => options.state.includes(label)) ?? labels[0];
        answers[id] = { _tag: "Classify", label: winner, probabilities: spread(labels, winner) };
      }
    }
    return { answers, usage: { inputTokens: 120, outputTokens: 20 } };
  }),
);

const heading = (text) => console.log(`\n${text}\n${"-".repeat(text.length)}`);

// --- 1. uncertainty is a branch, not a coin flip ------------------------------

const Change = Schema.String;
const OnChange = Discern.on(Change);

const impact = OnChange.classify({
  id: "api-impact",
  instructions: "Classify the public API impact of this change",
  criteria: {
    none: "No public API impact",
    behavioral: "Changes behavior of existing API",
    breaking: "Existing callers can break",
  },
});

const risky = OnChange.probability({
  id: "regression-risk",
  instructions: "This change is likely to cause a regression",
});

const review = Discern.type(Change).pipe(
  Discern.when(Discern.and(impact.is("breaking"), risky.above(0.8, { missBelow: 0.5 })), () => "block"),
  Discern.when(impact.is("breaking"), () => "migration-required"),
  Discern.when(risky.above(0.8, { missBelow: 0.5 }), () => "needs-a-second-pair-of-eyes"),
  Discern.onUncertain((_change, context) => `human-review (${context.result.reason})`),
  Discern.orElse(() => "ship"),
);

const program = Effect.gen(function* () {
  heading("1. Uncertainty is a branch of its own");
  for (const change of Object.keys(beliefs)) {
    const before = modelCalls;
    const verdict = yield* review(change);
    console.log(`  ${change.padEnd(26)} -> ${verdict}   [${modelCalls - before} model call]`);
  }
  console.log("\n  Both decisions are answered in one call per change, however many");
  console.log("  cases refer to them. `loosen a retry timeout` sits at risk 0.62 —");
  console.log("  neither above 0.8 nor below 0.5 — so it takes the uncertain branch");
  console.log("  instead of quietly falling through to `ship`.");

  // --- 2. record, replay, budget ---------------------------------------------

  heading("2. Observations are recorded, replayed and budgeted as a layer");
  const observations = Model.store();
  const spend = Model.budget({ decisions: 2 });

  const recorded = yield* review("drop a deprecated field").pipe(
    Effect.provide(Model.layer(stubModel, [Model.recording(observations), Model.budgeted(spend)])),
  );
  console.log(`  first run          -> ${recorded}`);
  console.log(`  spent              -> ${JSON.stringify(spend.spent())}`);
  console.log(`  observations kept  -> ${observations.size()}`);

  const callsBefore = modelCalls;
  const replayed = yield* review.replay("drop a deprecated field", observations.snapshot());
  console.log(`  replayed           -> ${replayed}   [${modelCalls - callsBefore} model calls]`);
  const refused = yield* review("rename a public export").pipe(
    Effect.provide(Model.layer(stubModel, [Model.budgeted(spend)])),
    Effect.catch((error) =>
      Effect.succeed(Model.isBudgetExceeded(error) ? "refused: budget exhausted" : `failed: ${error}`),
    ),
  );
  console.log(`  a third decision   -> ${refused}`);

  console.log("\n  The snapshot is plain JSON, so it travels in a bug report and");
  console.log("  reruns the same decision without a model. The budget is the same");
  console.log("  kind of layer, and refuses rather than overspending.");

  // --- 3. routing between procedures ---------------------------------------

  heading("3. Routing reports what it cannot decide");
  const reviewProc = Procedure.make({
    id: "review",
    description: "Review a change for correctness and semantic risk",
    input: Change,
    run: (change) => Effect.map(review(change), (verdict) => `review says: ${verdict}`),
  });
  const shipProc = Procedure.make({
    id: "ship",
    description: "Release a change that has already been reviewed",
    input: Change,
    run: (change) => Effect.succeed(`shipping: ${change}`),
  });
  const registry = Procedure.registry(Change, [reviewProc, shipProc], { id: "route" });

  const routed = yield* registry.invoke("drop a deprecated field");
  console.log(`  clear request      -> ${routed}`);

  const muddled = yield* registry.route("do the thing", { minProbability: 0.95 });
  console.log(`  unclear request    -> ${muddled._tag}: ${muddled.reason}`);
  console.log(`  ranked             -> ${muddled.ranked.map((c) => `${c.id} ${c.probability.toFixed(2)}`).join(", ")}`);
  console.log("\n  `invoke` would fail with RoutingUncertainError here rather than");
  console.log("  running whichever procedure happened to win by a hair.");
});

await Effect.runPromise(Effect.provide(program, Model.layer(stubModel)));
console.log(`\nTotal pretend model calls: ${modelCalls}\n`);
