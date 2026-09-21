/** Verify the illustrated execution paths against the real library, with fixed evidence. */
import assert from "node:assert/strict";
import { Effect } from "effect";
import * as Discern from "./media/example-run/src/index.js";
import * as Example from "./media/example-run/examples/explainer.js";

async function run(program, ambiguous = false) {
  let calls = 0;
  const provider = Discern.Model.provider(options => {
    calls++;
    const answers = {};
    for (const [key, decision] of Object.entries(options.decisions)) {
      if (decision._tag === "Probability") {
        answers[key] = { _tag: "Probability", probability: 0.62 };
      } else {
        const probabilities = "code" in decision.criteria ? { code: 0.95, help: 0.05 }
          : "breaking" in decision.criteria ? { breaking: 0.95, compatible: 0.05 }
          : ambiguous ? { review: 0.52, explain: 0.48 } : { review: 0.92, explain: 0.08 };
        const label = Object.keys(probabilities)[0];
        answers[key] = { _tag: "Classify", label, probabilities };
      }
    }
    return Effect.succeed({ answers, usage: { inputTokens: undefined, outputTokens: undefined } });
  });
  const value = await Effect.runPromise(Effect.provide(program, Discern.Model.layer(provider)));
  return { value, calls };
}

assert.deepEqual(await run(Example.direct), { value: "human-review", calls: 1 });
assert.deepEqual(await run(Example.routed), { value: "human-review", calls: 2 });
assert.deepEqual(await run(Example.routed, true), { value: "Please clarify: review or explain?", calls: 1 });
assert.deepEqual(await run(Example.nested), { value: "human-review", calls: 3 });
assert.deepEqual(await run(Example.strictReview(Example.change)), { value: "human-review", calls: 1 });
assert.deepEqual(await run(Example.reviewAndExplain), {
  value: { verdict: "human-review", summary: Example.change.summary }, calls: 1,
});
console.log("Verified six illustrated paths, including nested routing and uncertainty stopping execution.");
