/**
 * The README's before/after comparison, kept here so both halves are
 * typechecked. The "before" is ordinary Effect code using `Decision` directly;
 * the "after" is the same policy in Discern.
 *
 * Each half is deliberately self-contained — including its criteria — so that
 * the README can quote it as a standalone snippet.
 */
import { Effect, Schema } from "effect";
import * as Decision from "effect/unstable/ai/Decision";
import * as DecisionModel from "effect/unstable/ai/DecisionModel";
import * as Discern from "../src/index.js";

const Change = Schema.Struct({
  id: Schema.String,
  summary: Schema.String,
  diff: Schema.String,
});

// --- BEFORE ---
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
// --- END BEFORE ---

// --- AFTER ---
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
// --- END AFTER ---

export { review, reviewRaw };
