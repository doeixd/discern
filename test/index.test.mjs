import assert from "node:assert/strict";
import test from "node:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as DecisionModel from "effect/unstable/ai/DecisionModel";
import * as Discern from "../dist/index.js";

const { Model } = Discern;

/** A provider built from `(options) => Record<decisionId, ProviderAnswer>`. */
const providerOf = (fn) =>
  Model.provider((options) =>
    Effect.map(
      Effect.promise(async () => fn(options)),
      (answers) => ({ answers, usage: { inputTokens: undefined, outputTokens: undefined } }),
    ),
  );

/** Run an Effect against a provider function and an optional middleware stack. */
const run = (effect, fn, middleware = []) =>
  Effect.runPromise(Effect.provide(effect, Model.layer(providerOf(fn), middleware)));

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

/**
 * Plain Error subclasses are wrapped by Effect; AiError is yieldable and
 * arrives as itself (and exposes its reason as `.cause`).
 */
const causeOf = (error) => error?.cause ?? error;

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
    (error) => causeOf(error)?._tag === "UncertainMatchError",
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

  const policy = Discern.type(Schema.String).pipe(
    Discern.when(riskySource, () => "review"),
    Discern.orElse(() => "skip"),
  );

  assert.equal(await run(policy("README.md"), model), "skip");
  assert.equal(calls, 0, "a deterministic miss makes the semantic observation unnecessary");
  assert.equal(await run(policy("index.ts"), model), "review");
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

test("a trace reports which cases were evaluated and how each resolved", async () => {
  const model = (options) => answersFor(options, () => probabilityAnswer(0.2));
  const risky = Discern.on(Schema.String).probability({ id: "risk", instructions: "Risky" });

  const policy = Discern.type(Schema.String).pipe(
    Discern.when(risky.above(0.8), () => "block", { id: "high" }),
    Discern.orElse(() => "ship"),
  );

  const { value, trace } = await run(policy.runWithTrace("x"), model);
  assert.equal(value, "ship");
  assert.equal(trace.version, 2);
  assert.deepEqual(
    trace.cases.map((item) => [item.id, item.status]),
    [["high", "Miss"]],
  );
  assert.deepEqual(trace.selected, { _tag: "Fallback" });
  assert.equal(trace.answers.risk.probability, 0.2);
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

// -------------------------------------------------------------------------------------------------
// DecisionModel middleware
// -------------------------------------------------------------------------------------------------

test("recording captures observations that replay reruns without a provider", async () => {
  let calls = 0;
  let handled = 0;
  const model = (options) => {
    calls += 1;
    return answersFor(options, () => probabilityAnswer(0.95));
  };

  const risky = Discern.on(Schema.String).probability({ id: "risk", instructions: "Risky" });
  const policy = Discern.type(Schema.String).pipe(
    Discern.when(risky.above(0.8), (input) => {
      handled += 1;
      return `block:${input}`;
    }),
    Discern.orElse((input) => `ship:${input}`),
  );

  const store = Model.store();
  assert.equal(await run(policy("x"), model, [Model.recording(store)]), "block:x");
  assert.equal(calls, 1);
  assert.equal(handled, 1);
  assert.equal(store.size(), 1);

  const replayed = await Effect.runPromise(policy.replay("x", store.snapshot()));
  assert.equal(replayed, "block:x");
  assert.equal(calls, 1, "replay reaches no provider");
  assert.equal(handled, 2, "ordinary handler logic is replayed, not memoized");
});

test("observations are serializable and reload into a fresh store", async () => {
  const model = (options) => answersFor(options, () => probabilityAnswer(0.95));
  const risky = Discern.on(Schema.String).probability({ id: "risk", instructions: "Risky" });
  const policy = Discern.type(Schema.String).pipe(
    Discern.when(risky.above(0.8), () => "block"),
    Discern.orElse(() => "ship"),
  );

  const store = Model.store();
  await run(policy("x"), model, [Model.recording(store)]);

  const roundTripped = JSON.parse(JSON.stringify(store.snapshot()));
  assert.equal(await Effect.runPromise(policy.replay("x", roundTripped)), "block");
});

test("replay fails when the decision definition changed since recording", async () => {
  const model = (options) => answersFor(options, () => probabilityAnswer(0.95));
  const OnChange = Discern.on(Schema.String);

  const before = OnChange.probability({ id: "risk", instructions: "Risky" });
  const after = OnChange.probability({ id: "risk", instructions: "Risky, reworded" });

  const policyOf = (decision) =>
    Discern.type(Schema.String).pipe(
      Discern.when(decision.above(0.8), () => "block"),
      Discern.orElse(() => "ship"),
    );

  const store = Model.store();
  await run(policyOf(before)("x"), model, [Model.recording(store)]);

  assert.equal(await Effect.runPromise(policyOf(before).replay("x", store.snapshot())), "block");
  await assert.rejects(
    () => Effect.runPromise(policyOf(after).replay("x", store.snapshot())),
    (error) => Model.isReplayMiss(error),
  );
});

test("the same decision asked about different inputs is recorded separately", async () => {
  const model = (options) =>
    answersFor(options, () => probabilityAnswer(options.state === "risky.ts" ? 0.95 : 0.05));

  const risky = Discern.on(Schema.String).probability({ id: "risk", instructions: "Risky" });
  const policy = Discern.type(Schema.String).pipe(
    Discern.when(risky.above(0.8), () => "block"),
    Discern.orElse(() => "ship"),
  );

  const store = Model.store();
  assert.equal(await run(policy("risky.ts"), model, [Model.recording(store)]), "block");
  assert.equal(await run(policy("safe.ts"), model, [Model.recording(store)]), "ship");
  assert.equal(store.size(), 2, "content addressing keys on the input, not just the decision id");

  assert.equal(await Effect.runPromise(policy.replay("risky.ts", store.snapshot())), "block");
  assert.equal(await Effect.runPromise(policy.replay("safe.ts", store.snapshot())), "ship");
});

test("caching reuses observations but not handler effects", async () => {
  let calls = 0;
  let handled = 0;
  const model = (options) => {
    calls += 1;
    return answersFor(options, () => probabilityAnswer(0.95));
  };

  const risky = Discern.on(Schema.String).probability({ id: "risk", instructions: "Risky" });
  const policy = Discern.type(Schema.String).pipe(
    Discern.when(risky.above(0.8), () => {
      handled += 1;
      return "block";
    }),
    Discern.orElse(() => "ship"),
  );

  const store = Model.store();
  const cache = [Model.caching(store)];
  assert.equal(await run(policy("same"), model, cache), "block");
  assert.equal(await run(policy("same"), model, cache), "block");
  assert.equal(calls, 1);
  assert.equal(handled, 2);
});

test("caching is partial: only uncached decisions reach the provider", async () => {
  const asked = [];
  const model = (options) => {
    asked.push(Object.keys(options.decisions).sort());
    return answersFor(options, () => probabilityAnswer(0.9));
  };

  const OnChange = Discern.on(Schema.String);
  const a = OnChange.probability({ id: "a", instructions: "First" });
  const b = OnChange.probability({ id: "b", instructions: "Second" });

  const onlyA = Discern.type(Schema.String).pipe(
    Discern.when(a.above(0.8), () => "a"),
    Discern.orElse(() => "none"),
  );
  const both = Discern.type(Schema.String).pipe(
    Discern.when(Discern.and(a.above(0.8), b.above(0.8)), () => "both"),
    Discern.orElse(() => "none"),
  );

  const store = Model.store();
  const cache = [Model.caching(store)];
  assert.equal(await run(onlyA("x"), model, cache), "a");
  assert.equal(await run(both("x"), model, cache), "both");

  assert.deepEqual(asked, [["a"], ["b"]], "the second run asks only for the decision it lacks");
});

test("a budget limits provider spend and reports what was used", async () => {
  const model = (options) => answersFor(options, () => probabilityAnswer(0.9));
  const risky = Discern.on(Schema.String).probability({ id: "risk", instructions: "Risky" });
  const policy = Discern.type(Schema.String).pipe(
    Discern.when(risky.above(0.8), () => "block"),
    Discern.orElse(() => "ship"),
  );

  const spend = Model.budget({ decisions: 2 });
  const limited = [Model.budgeted(spend)];

  assert.equal(await run(policy("a"), model, limited), "block");
  assert.equal(await run(policy("b"), model, limited), "block");
  assert.deepEqual(spend.spent(), { decisions: 2, calls: 2 });

  await assert.rejects(
    () => run(policy("c"), model, limited),
    (error) => Model.isBudgetExceeded(error),
  );
});

test("cached observations do not draw from the budget", async () => {
  const model = (options) => answersFor(options, () => probabilityAnswer(0.9));
  const risky = Discern.on(Schema.String).probability({ id: "risk", instructions: "Risky" });
  const policy = Discern.type(Schema.String).pipe(
    Discern.when(risky.above(0.8), () => "block"),
    Discern.orElse(() => "ship"),
  );

  const store = Model.store();
  const spend = Model.budget({ decisions: 1 });
  const stack = [Model.caching(store), Model.budgeted(spend)];

  assert.equal(await run(policy("x"), model, stack), "block");
  assert.equal(await run(policy("x"), model, stack), "block");
  assert.deepEqual(spend.spent(), { decisions: 1, calls: 1 }, "the second run was served from cache");
});

test("one store records and replays a program spanning several policies", async () => {
  let calls = 0;
  const model = (options) => {
    calls += 1;
    return answersFor(options, (decision) =>
      decision.instructions === "Risky" ? probabilityAnswer(0.95) : probabilityAnswer(0.1),
    );
  };

  const OnChange = Discern.on(Schema.String);
  const risky = OnChange.probability({ id: "risk", instructions: "Risky" });
  const urgent = OnChange.probability({ id: "urgent", instructions: "Urgent" });

  const riskPolicy = Discern.type(Schema.String).pipe(
    Discern.when(risky.above(0.8), () => "risky"),
    Discern.orElse(() => "safe"),
  );
  const urgencyPolicy = Discern.type(Schema.String).pipe(
    Discern.when(urgent.above(0.8), () => "now"),
    Discern.orElse(() => "later"),
  );

  // Two independent policies inside one ordinary Effect program.
  const program = (input) =>
    Effect.gen(function* () {
      const risk = yield* riskPolicy(input);
      const when = yield* urgencyPolicy(input);
      return `${risk}/${when}`;
    });

  const store = Model.store();
  assert.equal(await run(program("x"), model, [Model.recording(store)]), "risky/later");
  assert.equal(calls, 2, "each policy made its own provider call");
  assert.equal(store.size(), 2);

  // The whole program replays from one store, including code Discern never sees.
  const replayed = await Effect.runPromise(
    Effect.provide(program("x"), Model.replayLayer(store.snapshot())),
  );
  assert.equal(replayed, "risky/later");
  assert.equal(calls, 2, "replaying the composed program reaches no provider");
});

test("interceptors decorate a DecisionModel layer Discern did not build", async () => {
  let calls = 0;

  // A layer built with the plain Effect API, as a provider package would ship it.
  const thirdParty = Layer.effect(DecisionModel.DecisionModel)(
    DecisionModel.make({
      decide: (options) =>
        Effect.sync(() => {
          calls += 1;
          return {
            answers: answersFor(options, () => probabilityAnswer(0.95)),
            usage: { inputTokens: 7, outputTokens: 3 },
          };
        }),
    }),
  );

  const risky = Discern.on(Schema.String).probability({ id: "risk", instructions: "Risky" });
  const policy = Discern.type(Schema.String).pipe(
    Discern.when(risky.above(0.8), () => "block"),
    Discern.orElse(() => "ship"),
  );

  const observations = Model.store();
  const spend = Model.budget({ calls: 1 });
  const decorated = thirdParty.pipe(
    Model.intercept([Model.recording(observations), Model.caching(observations), Model.budgeted(spend)]),
  );

  assert.equal(await Effect.runPromise(Effect.provide(policy("x"), decorated)), "block");
  assert.equal(calls, 1);
  assert.equal(observations.size(), 1);

  // The cache absorbs the second run, so the one-call budget is never charged again.
  assert.equal(await Effect.runPromise(Effect.provide(policy("x"), decorated)), "block");
  assert.equal(calls, 1);
  assert.deepEqual(spend.spent(), { decisions: 1, calls: 1 });

  assert.equal(await Effect.runPromise(policy.replay("x", observations.snapshot())), "block");
});
