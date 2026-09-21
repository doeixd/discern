import assert from "node:assert/strict";
import test from "node:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as DecisionModel from "effect/unstable/ai/DecisionModel";
import * as Discern from "../dist/index.js";

/**
 * Builds a DecisionModel layer from a plain function
 * `(options: { state, decisions }) => Record<string, ProviderAnswer>`.
 */
const provider = (fn) =>
  Layer.effect(DecisionModel.DecisionModel)(
    DecisionModel.make({
      decide: (options) =>
        Effect.map(
          Effect.promise(async () => fn(options)),
          (answers) => ({ answers, usage: { inputTokens: undefined, outputTokens: undefined } }),
        ),
    }),
  );

/** Run an Effect against a provider function. */
const run = (effect, fn) => Effect.runPromise(Effect.provide(effect, provider(fn)));

/** Map every requested decision to a provider answer. */
const answersFor = (options, values) => {
  const answers = {};
  for (const [key, decision] of Object.entries(options.decisions)) {
    answers[key] = values(decision, key);
  }
  return answers;
};

const classifyAnswer = (label, probabilities) => ({ _tag: "Classify", label, probabilities });
const probabilityAnswer = (probability) => ({ _tag: "Probability", probability });
const rateAnswer = (rating, probabilities) => ({ _tag: "Rate", rating, probabilities });

/** Errors surface as the failure cause once they cross Effect.runPromise. */
const tagOf = (error) => (error?.cause ?? error)?._tag;

test("batches unique decisions and reuses a classification across cases", async () => {
  let calls = 0;
  let decisionCount = 0;
  const model = (options) => {
    calls += 1;
    decisionCount = Object.keys(options.decisions).length;
    return answersFor(options, (decision) =>
      decision._tag === "Classify"
        ? classifyAnswer("breaking", { none: 0.01, behavioral: 0.09, breaking: 0.9 })
        : probabilityAnswer(0.91),
    );
  };

  const OnChange = Discern.on(Schema.String);
  const impact = OnChange.classify({
    id: "api-impact",
    instructions: "Classify API impact",
    criteria: { none: "none", behavioral: "behavioral", breaking: "breaking" },
  });
  const risky = OnChange.probability({ id: "regression-risk", instructions: "Likely to regress" });

  const review = Discern.type(Schema.String).pipe(
    Discern.when(Discern.and(impact.is("breaking"), risky.above(0.8)), (change) => `block:${change}`),
    Discern.when(impact.is("breaking"), (change) => `migrate:${change}`),
    Discern.orElse((change) => `ship:${change}`),
  );

  assert.equal(await run(review("change-1"), model), "block:change-1");
  assert.equal(calls, 1, "one provider call for the whole matcher");
  assert.equal(decisionCount, 2, "the shared classification is requested once");
  assert.equal(review.plan.decisions.length, 2);
  assert.equal(review.plan.decisions[0].id, "api-impact");
});

test("tri-state uncertainty does not silently fall through to the fallback", async () => {
  const model = (options) => answersFor(options, () => probabilityAnswer(0.7));

  const risk = Discern.on(Schema.String).probability({ id: "risk", instructions: "Risky" });
  const matcher = Discern.type(Schema.String).pipe(
    Discern.when(risk.above(0.8, { missBelow: 0.5 }), () => "block", { id: "high-risk" }),
    Discern.onUncertain((_input, context) => `review:${context.caseId}`),
    Discern.orElse(() => "ship"),
  );

  assert.equal(await run(matcher("x"), model), "review:high-risk");

  const unsafeFallback = Discern.type(Schema.String).pipe(
    Discern.when(risk.above(0.8, { missBelow: 0.5 }), () => "block", { id: "high-risk" }),
    Discern.orElse(() => "ship"),
  );

  await assert.rejects(
    () => run(unsafeFallback("x"), model),
    (error) => tagOf(error) === "UncertainMatchError",
  );
});

test("semantic and deterministic patterns compose and can avoid the provider", async () => {
  let calls = 0;
  const model = (options) => {
    calls += 1;
    return answersFor(options, () => probabilityAnswer(0.99));
  };

  const risk = Discern.on(Schema.String).probability({ id: "risk", instructions: "Risky" });
  const onlySourceFiles = Discern.deterministic((path) => path.endsWith(".ts"), {
    id: "source-file",
    description: "Only TypeScript source files",
  });
  const riskySource = Discern.and(onlySourceFiles, risk.above(0.8));

  const program = Discern.type(Schema.String).pipe(
    Discern.when(riskySource, () => "review"),
    Discern.orElse(() => "skip"),
  );

  assert.equal(await run(program("README.md"), model), "skip");
  assert.equal(calls, 0, "a deterministic miss makes the semantic observation unnecessary");
  assert.equal(await run(program("index.ts"), model), "review");
  assert.equal(calls, 1);
});

test("classification match is exhaustively dispatched by label", async () => {
  const model = (options) =>
    answersFor(options, () =>
      classifyAnswer("behavioral", { none: 0.05, additive: 0.1, behavioral: 0.8, breaking: 0.05 }),
    );

  const impact = Discern.on(Schema.String).classify({
    id: "impact",
    instructions: "Classify impact",
    criteria: { none: "none", additive: "additive", behavioral: "behavioral", breaking: "breaking" },
  });

  const handle = Discern.match(impact).pipe(
    Discern.case("none", () => "ship"),
    Discern.case("additive", () => "docs"),
    Discern.case("behavioral", () => "review"),
    Discern.case("breaking", () => "migrate"),
    Discern.exhaustive,
  );

  assert.equal(await run(handle("change"), model), "review");
});

test("ordered ratings compare by position on the scale", async () => {
  const model = (options) =>
    answersFor(options, () => rateAnswer(2, { trivial: 0, minor: 0, major: 1, critical: 0 }));

  const severity = Discern.on(Schema.String).rate({
    id: "severity",
    instructions: "Rate severity",
    criteria: ["trivial", "minor", "major", "critical"],
  });

  const triage = Discern.type(Schema.String).pipe(
    Discern.when(severity.atMost("minor"), () => "queue"),
    Discern.when(severity.atLeast("major"), () => "escalate"),
    Discern.orElse(() => "unclassified"),
  );

  assert.equal(await run(triage("x"), model), "escalate");
});

test("compiled plans are inspectable and stable for stable decision ids", () => {
  const make = () => {
    const OnChange = Discern.on(Schema.String);
    const impact = OnChange.classify({
      id: "impact",
      instructions: "Classify impact",
      criteria: { safe: "safe", breaking: "breaking" },
    });
    return Discern.type(Schema.String).pipe(
      Discern.when(impact.is("breaking"), () => "block", { id: "breaking" }),
    );
  };

  const a = Discern.compile(make());
  const b = Discern.compile(make());
  assert.deepEqual(a, b);
  assert.equal(a.decisions[0].id, "impact");
  assert.match(a.fingerprint, /^plan_/);
});

test("record/replay reruns ordinary handlers without calling the provider", async () => {
  let calls = 0;
  let handled = 0;
  const model = (options) => {
    calls += 1;
    return answersFor(options, () => probabilityAnswer(0.95));
  };

  const risky = Discern.on(Schema.String).probability({ id: "risk", instructions: "Risky" });
  const program = Discern.type(Schema.String).pipe(
    Discern.when(risky.above(0.8), (input) => {
      handled += 1;
      return `block:${input}`;
    }),
    Discern.orElse((input) => `ship:${input}`),
  );

  const first = await run(program.runWithTrace("x"), model);
  assert.equal(first.value, "block:x");
  assert.equal(calls, 1);
  assert.equal(handled, 1);

  const second = await Effect.runPromise(program.replay("x", first.trace));
  assert.equal(second, "block:x");
  assert.equal(calls, 1, "replay uses the recorded semantic observations");
  assert.equal(handled, 2, "ordinary handler logic is replayed, not memoized");
});

test("replay rejects a trace recorded for a different plan", async () => {
  const model = (options) => answersFor(options, () => probabilityAnswer(0.95));
  const risky = Discern.on(Schema.String).probability({ id: "risk", instructions: "Risky" });

  const program = Discern.type(Schema.String).pipe(
    Discern.when(risky.above(0.8), () => "block"),
    Discern.orElse(() => "ship"),
  );
  const other = Discern.type(Schema.String).pipe(
    Discern.when(risky.above(0.5), () => "block"),
    Discern.orElse(() => "ship"),
  );

  const { trace } = await run(program.runWithTrace("x"), model);
  await assert.rejects(
    () => Effect.runPromise(other.replay("x", trace)),
    (error) => tagOf(error) === "ReplayMismatchError",
  );
});

test("trace cache skips semantic observations but not handler effects", async () => {
  let calls = 0;
  let handled = 0;
  const model = (options) => {
    calls += 1;
    return answersFor(options, () => probabilityAnswer(0.95));
  };

  const risky = Discern.on(Schema.String).probability({ id: "risk", instructions: "Risky" });
  const base = Discern.type(Schema.String).pipe(
    Discern.when(risky.above(0.8), () => {
      handled += 1;
      return "block";
    }),
    Discern.orElse(() => "ship"),
  );
  const cached = Discern.cached(base, { cache: Discern.memoryCache(), key: (input) => input });

  assert.equal(await run(cached("same"), model), "block");
  assert.equal(await run(cached("same"), model), "block");
  assert.equal(calls, 1);
  assert.equal(handled, 2);
});

test("reusing one decision id for two different definitions is rejected", () => {
  const OnChange = Discern.on(Schema.String);
  const a = OnChange.probability({ id: "risk", instructions: "Risky" });
  const b = OnChange.probability({ id: "risk", instructions: "Something else entirely" });

  assert.throws(() => Discern.and(a.above(0.8), b.above(0.8)), /Decision id collision/);
});

test("Eval.sweep reuses one semantic observation per example across thresholds", async () => {
  let calls = 0;
  const model = (options) => {
    calls += 1;
    return answersFor(options, () => probabilityAnswer(Number(options.state)));
  };

  const schema = Schema.String;
  const risky = Discern.on(schema).probability({ id: "risk", instructions: "Risky" });
  const examples = [
    { input: "0.95", expected: true },
    { input: "0.80", expected: true },
    { input: "0.55", expected: false },
    { input: "0.10", expected: false },
  ];

  const result = await run(
    Discern.Eval.calibrate({
      schema,
      values: [0.5, 0.7, 0.9],
      pattern: (threshold) => risky.atLeast(threshold),
      examples,
      metric: "f1",
    }),
    model,
  );

  assert.equal(calls, examples.length, "a threshold sweep does not multiply provider calls");
  assert.equal(result.best.value, 0.7);
  assert.equal(result.best.report.metrics.f1, 1);
});
