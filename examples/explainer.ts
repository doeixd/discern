/** Source for the video's code excerpts. Model answers in the video are illustrative. */
import { Effect, Schema } from "effect";
import * as Decision from "effect/unstable/ai/Decision";
import * as DecisionModel from "effect/unstable/ai/DecisionModel";
import * as Discern from "../src/index.js";
import * as Procedure from "../src/procedure.js";

export const Change = Schema.Struct({ summary: Schema.String, diff: Schema.String });
export const change = {
  summary: "Remove the deprecated retry field",
  diff: "- retry?: number;",
};

// video:decision
const riskQuestion = Decision.probability({
  instructions: "This change will cause a regression",
});
// endvideo

const questions = Decision.make({ input: Change, decisions: { risk: riskQuestion } });
export const observe = DecisionModel.decide(questions, { input: change });

// video:pattern
const risk = Discern.on(Change).probability({
  id: "risk",
  instructions: "This change will cause a regression",
});
const highRisk = risk.atLeast(0.8, { missBelow: 0.5 });
// endvideo

// video:policy
const review = Discern.type(Change).pipe(
  Discern.when(highRisk, () => "block"),
  Discern.onUncertain(() => "human-review"),
  Discern.orElse(() => "ship"),
);
// endvideo

const impact = Discern.on(Change).classify({
  id: "impact",
  instructions: "Classify the public API impact of this change",
  criteria: { breaking: "Existing callers can break", compatible: "Existing callers still work" },
});

// video:combined
const breaking = impact.is("breaking");
const strictReview = Discern.type(Change).pipe(
  Discern.when(Discern.and(breaking, highRisk), () => "block"),
  Discern.when(breaking, () => "migration-required"),
  Discern.onUncertain(() => "human-review"),
  Discern.orElse(() => "ship"),
);
// endvideo
export { strictReview };

export const Request = Schema.Struct({ ask: Schema.String, change: Change });
export const request = { ask: "Is this safe to ship?", change };

// video:procedure
const reviewChange = Procedure.make({
  id: "review",
  description: "Judge whether a change is safe to release",
  input: Request,
  run: request => review(request.change),
});
// endvideo

const explainChange = Procedure.make({
  id: "explain",
  description: "Return the supplied change summary",
  input: Request,
  run: request => Effect.succeed(request.change.summary),
});

// video:registry
const changes = Procedure.registry(Request, [reviewChange, explainChange]);
// endvideo
export const direct = reviewChange.run(request);
export const routed = changes.invoke(request, {
  onUncertain: () => "Please clarify: review or explain?",
});

const help = Procedure.make({
  id: "help",
  description: "Show instructions for using this assistant",
  input: Request,
  run: () => Effect.succeed("Ask to review a change or explain its summary."),
});

// video:nested
const code = Procedure.fromRegistry({
  id: "code",
  description: "Review or explain a code change",
  registry: changes,
});
const assistant = Procedure.registry(Request, [code, help]);
// endvideo
export const nested = assistant.invoke(request).pipe(Procedure.withMaxDepth(4));

// A known sequence is ordinary Effect composition; no router is needed to select it.
export const reviewAndExplain = Effect.gen(function* () {
  const verdict = yield* reviewChange.run(request);
  const summary = yield* explainChange.run(request);
  return { verdict, summary };
});
