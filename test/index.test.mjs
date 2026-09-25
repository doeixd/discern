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

  assert.throws(
    () => Discern.and(a.above(0.8), b.above(0.8)),
    (error) => error instanceof Discern.DecisionIdCollisionError && error.decisionId === "risk",
  );
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

test("reordering classification criteria is a cache miss, not a silent reuse", async () => {
  // Criteria reach the provider in declaration order, so a reorder may change
  // the answer. Addresses must not treat the two as interchangeable.
  const make = (criteria) =>
    Discern.on(Schema.String).classify({ id: "impact", instructions: "Classify", criteria });

  const a = make({ safe: "Safe", breaking: "Breaks callers" });
  const b = make({ breaking: "Breaks callers", safe: "Safe" });
  assert.notEqual(a.fingerprint, b.fingerprint);

  let calls = 0;
  const model = (options) => {
    calls += 1;
    return answersFor(options, () => classifyAnswer("safe", { safe: 0.9, breaking: 0.1 }));
  };
  const policyOf = (decision) =>
    Discern.type(Schema.String).pipe(
      Discern.when(decision.is("safe"), () => "ok"),
      Discern.orElse(() => "no"),
    );

  const store = Model.store();
  const cache = [Model.caching(store)];
  await run(policyOf(a)("x"), model, cache);
  await run(policyOf(b)("x"), model, cache);
  assert.equal(calls, 2, "the reordered decision is asked again rather than reusing the answer");
});

test("input objects are addressed structurally, so key order does not split the cache", async () => {
  const Ticket = Schema.Record(Schema.String, Schema.Number);
  const busy = Discern.on(Ticket).probability({ id: "busy", instructions: "Busy" });
  const policy = Discern.type(Ticket).pipe(
    Discern.when(busy.above(0.8), () => "yes"),
    Discern.orElse(() => "no"),
  );

  let calls = 0;
  const model = (options) => {
    calls += 1;
    return answersFor(options, () => probabilityAnswer(0.9));
  };

  const store = Model.store();
  const cache = [Model.caching(store)];
  assert.equal(await run(policy({ a: 1, b: 2 }), model, cache), "yes");
  assert.equal(await run(policy({ b: 2, a: 1 }), model, cache), "yes");
  assert.equal(calls, 1, "the same JSON object in a different key order is the same input");
});

test("ask with an unscoped decision fails as a defect rather than throwing", async () => {
  const unscoped = Discern.probability({ id: "u", instructions: "x" });
  const effect = Discern.ask(unscoped, "x");
  await assert.rejects(() => run(effect, () => ({})), /requires a schema-scoped decision/);
});

test("Eval.sweep skips decisions that deterministic structure already settles", async () => {
  let asked = 0;
  const model = (options) => {
    asked += 1;
    return answersFor(options, () => probabilityAnswer(0.9));
  };

  const risky = Discern.on(Schema.String).probability({ id: "risk", instructions: "Risky" });
  const sourceOnly = Discern.deterministic((path) => path.endsWith(".ts"), { id: "source" });

  const result = await run(
    Discern.Eval.sweep({
      schema: Schema.String,
      values: [0.5, 0.9],
      pattern: (threshold) => Discern.and(sourceOnly, risky.atLeast(threshold)),
      examples: [
        { input: "a.ts", expected: true },
        { input: "b.md", expected: false },
        { input: "c.md", expected: false },
      ],
    }),
    model,
  );

  assert.equal(asked, 1, "only the .ts example needs the model");
  assert.deepEqual(
    result.map((entry) => [entry.value, entry.report.metrics.accuracy]),
    [
      [0.5, 1],
      [0.9, 1],
    ],
  );
});

test("replaying can fall through to the model for anything it lacks", async () => {
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
  await run(onlyA("x"), model, [Model.recording(store)]);
  assert.deepEqual(asked, [["a"]]);

  // Strict replay refuses, because `b` was never recorded.
  await assert.rejects(
    () => Effect.runPromise(both.replay("x", store.snapshot())),
    (error) => Model.isReplayMiss(error),
  );

  // `onMissing: "ask"` replays what it has and asks for the rest.
  const result = await run(both("x"), model, [Model.replaying(store, { onMissing: "ask" })]);
  assert.equal(result, "both");
  assert.deepEqual(asked, [["a"], ["b"]], "only the unrecorded decision reached the model");
});

test("load replaces the store, so a snapshot round-trips exactly", async () => {
  const model = (options) => answersFor(options, () => probabilityAnswer(0.9));
  const OnChange = Discern.on(Schema.String);
  const a = OnChange.probability({ id: "a", instructions: "First" });
  const b = OnChange.probability({ id: "b", instructions: "Second" });
  const policyOf = (decision) =>
    Discern.type(Schema.String).pipe(
      Discern.when(decision.above(0.8), () => "hit"),
      Discern.orElse(() => "miss"),
    );

  const first = Model.store();
  await run(policyOf(a)("x"), model, [Model.recording(first)]);
  const second = Model.store();
  await run(policyOf(b)("x"), model, [Model.recording(second)]);

  first.load(second.snapshot());
  assert.equal(first.size(), 1, "loading replaces rather than merges");

  // `a` was deliberately absent from the loaded fixture, so replay must miss.
  await assert.rejects(
    () => Effect.runPromise(policyOf(a).replay("x", first.snapshot())),
    (error) => Model.isReplayMiss(error),
  );
  assert.equal(await Effect.runPromise(policyOf(b).replay("x", first.snapshot())), "hit");
});

test("an observation format from another version is rejected, not trusted", () => {
  assert.throws(() => Model.store({ version: 1, entries: {} }), /Unsupported observation format v1/);
  assert.throws(() => Model.store().load({ version: 99, entries: {} }), /Unsupported observation format v99/);
});

test("a miss bound on the wrong side of its match bound is refused when the pattern is built", () => {
  const OnChange = Discern.on(Schema.String);
  const risk = OnChange.probability({ id: "risk", instructions: "Risky" });
  const impact = OnChange.classify({ id: "impact", instructions: "Impact", criteria: { none: "n", breaking: "b" } });
  const refused = (miss, match) => (error) =>
    error instanceof Discern.InvalidThresholdError && error.miss === miss && error.match === match;

  assert.throws(() => risk.above(0.5, { missBelow: 0.8 }), refused(0.8, 0.5));
  assert.throws(() => risk.atLeast(0.5, { missBelow: 0.8 }), refused(0.8, 0.5));
  assert.throws(() => risk.below(0.5, { missAbove: 0.2 }), refused(0.2, 0.5));
  assert.throws(() => risk.atMost(0.5, { missAbove: 0.2 }), refused(0.2, 0.5));
  assert.throws(() => risk.band({ match: 0.5, miss: 0.8 }), refused(0.8, 0.5));
  assert.throws(() => impact.is("breaking", { match: 0.5, miss: 0.8 }), refused(0.8, 0.5));

  // Equal bounds are a plain two-way threshold, not a mistake.
  risk.above(0.5, { missBelow: 0.5 });
  risk.below(0.5, { missAbove: 0.5 });
  risk.band({ match: 0.5, miss: 0.5 });
});

test("Eval.calibrate refuses an empty candidate list before asking the model", async () => {
  let calls = 0;
  const model = (options) => {
    calls += 1;
    return answersFor(options, () => probabilityAnswer(0.9));
  };
  const risky = Discern.on(Schema.String).probability({ id: "risk", instructions: "Risky" });

  // Returned as a defect inside the Effect, not thrown by the call.
  const effect = Discern.Eval.calibrate({
    schema: Schema.String,
    values: [],
    pattern: (threshold) => risky.atLeast(threshold),
    examples: [{ input: "x", expected: true }],
  });
  await assert.rejects(() => run(effect, model), /at least one candidate value/);
  assert.equal(calls, 0);
});

test("a snapshot decodes through the Observations schema and replays", async () => {
  const model = (options) => answersFor(options, () => probabilityAnswer(0.95));
  const risky = Discern.on(Schema.String).probability({ id: "risk", instructions: "Risky" });
  const policy = Discern.type(Schema.String).pipe(
    Discern.when(risky.above(0.8), () => "block"),
    Discern.orElse(() => "ship"),
  );
  const store = Model.store();
  await run(policy("x"), model, [Model.recording(store)]);

  const text = JSON.stringify(store.snapshot());
  const decoded = Schema.decodeUnknownSync(Model.Observations)(JSON.parse(text));
  assert.equal(await Effect.runPromise(policy.replay("x", decoded)), "block");
});

test("the Observations schema refuses a malformed or foreign recording", () => {
  const decode = Schema.decodeUnknownSync(Model.Observations);
  const entry = { decisionId: "risk", fingerprint: "df_x", kind: "Probability", region: [], answer: {} };

  assert.throws(() => decode({ version: 1, entries: {} }));
  assert.throws(() => decode({ version: 2 }));
  assert.throws(() => decode({ version: 2, entries: { o_x: { ...entry, kind: "Guess" } } }));
  assert.throws(() => decode({ version: 2, entries: { o_x: { ...entry, region: "root" } } }));
  assert.equal(decode({ version: 2, entries: { o_x: entry } }).entries.o_x.decisionId, "risk");
});

/** The status a pattern gives for one answer to its only decision. */
const statusOf = (pattern, answer) => pattern.evaluate(undefined, { [pattern.decisions[0].id]: answer })._tag;

test("probability thresholds split exactly at their bounds", () => {
  const risk = Discern.on(Schema.String).probability({ id: "risk", instructions: "Risky" });
  const at = (pattern, p) => statusOf(pattern, probabilityAnswer(p));

  // Strict and inclusive differ only at the threshold itself.
  assert.equal(at(risk.above(0.5), 0.5), "Miss");
  assert.equal(at(risk.above(0.5), 0.51), "Match");
  assert.equal(at(risk.atLeast(0.5), 0.5), "Match");
  assert.equal(at(risk.below(0.2), 0.2), "Miss");
  assert.equal(at(risk.below(0.2), 0.19), "Match");
  assert.equal(at(risk.atMost(0.2), 0.2), "Match");

  // The miss bound is inclusive; everything strictly between is Uncertain.
  const guarded = risk.above(0.8, { missBelow: 0.5 });
  assert.equal(at(guarded, 0.5), "Miss");
  assert.equal(at(guarded, 0.6), "Uncertain");
  assert.equal(at(guarded, 0.8), "Uncertain");
  assert.equal(at(guarded, 0.81), "Match");
  assert.equal(at(risk.atLeast(0.8, { missBelow: 0.5 }), 0.8), "Match");

  const low = risk.below(0.2, { missAbove: 0.5 });
  assert.equal(at(low, 0.3), "Uncertain");
  assert.equal(at(low, 0.5), "Miss");

  const band = risk.band({ match: 0.8, miss: 0.5 });
  assert.equal(at(band, 0.8), "Match");
  assert.equal(at(band, 0.65), "Uncertain");
  assert.equal(at(band, 0.5), "Miss");

  const between = risk.between(0.4, 0.6);
  assert.equal(at(between, 0.4), "Match");
  assert.equal(at(between, 0.6), "Match");
  assert.equal(at(between, 0.61), "Miss");

  // Equal bounds leave no room for Uncertain.
  for (const p of [0, 0.49, 0.5, 0.51, 1]) {
    assert.notEqual(at(risk.above(0.5, { missBelow: 0.5 }), p), "Uncertain");
  }
});

test("a classification threshold reads the probability of the label, not the chosen label", () => {
  const impact = Discern.on(Schema.String).classify({
    id: "impact",
    instructions: "Impact",
    criteria: { none: "n", additive: "a", breaking: "b" },
  });

  // Without thresholds, only the provider's chosen label counts.
  assert.equal(statusOf(impact.is("breaking"), classifyAnswer("breaking", { none: 0.3, additive: 0.3, breaking: 0.4 })), "Match");
  assert.equal(statusOf(impact.is("breaking"), classifyAnswer("none", { none: 0.4, additive: 0.2, breaking: 0.4 })), "Miss");

  const sure = impact.is("breaking", { match: 0.8, miss: 0.3 });
  assert.equal(statusOf(sure, classifyAnswer("breaking", { none: 0.1, additive: 0.1, breaking: 0.8 })), "Match");
  assert.equal(statusOf(sure, classifyAnswer("breaking", { none: 0.25, additive: 0.25, breaking: 0.5 })), "Uncertain");
  assert.equal(statusOf(sure, classifyAnswer("none", { none: 0.4, additive: 0.3, breaking: 0.3 })), "Miss");

  // `miss` defaults to `match`, so omitting it makes the check two-valued.
  const defaulted = impact.is("breaking", {});
  assert.equal(statusOf(defaulted, classifyAnswer("breaking", { none: 0.11, additive: 0.1, breaking: 0.79 })), "Miss");
  assert.equal(statusOf(defaulted, classifyAnswer("breaking", { none: 0.1, additive: 0.1, breaking: 0.8 })), "Match");

  // Clearing `match` without the margin is Uncertain, not a Match or a Miss.
  const clear = impact.is("breaking", { match: 0.5, margin: 0.2 });
  assert.equal(statusOf(clear, classifyAnswer("breaking", { none: 0, additive: 0.45, breaking: 0.55 })), "Uncertain");
  assert.equal(statusOf(clear, classifyAnswer("breaking", { none: 0.1, additive: 0.3, breaking: 0.6 })), "Match");
});

test("oneOf, not and margin read a classification", () => {
  const impact = Discern.on(Schema.String).classify({
    id: "impact",
    instructions: "Impact",
    criteria: { none: "n", additive: "a", breaking: "b" },
  });
  const additive = classifyAnswer("additive", { none: 0.2, additive: 0.5, breaking: 0.3 });

  assert.equal(statusOf(impact.oneOf("additive", "breaking"), additive), "Match");
  assert.equal(statusOf(impact.oneOf("none", "breaking"), additive), "Miss");
  assert.equal(statusOf(impact.not("breaking"), additive), "Match");
  assert.equal(statusOf(impact.not("additive"), additive), "Miss");
  assert.equal(statusOf(impact.margin("additive", "breaking", 0.2), additive), "Match");
  assert.equal(statusOf(impact.margin("additive", "breaking", 0.21), additive), "Miss");
});

test("rating comparisons are inclusive at both ends of the scale", () => {
  const severity = Discern.on(Schema.String).rate({
    id: "severity",
    instructions: "Severity",
    criteria: ["trivial", "minor", "major", "critical"],
  });
  const even = { trivial: 0.25, minor: 0.25, major: 0.25, critical: 0.25 };
  const rated = (rating, label) => ({ ...rateAnswer(rating, even), label });

  assert.equal(statusOf(severity.atLeast("trivial"), rated(0, "trivial")), "Match");
  assert.equal(statusOf(severity.atMost("critical"), rated(3, "critical")), "Match");
  assert.equal(statusOf(severity.atLeast("major"), rated(2, "major")), "Match");
  assert.equal(statusOf(severity.atLeast("major"), rated(1, "minor")), "Miss");
  assert.equal(statusOf(severity.atMost("minor"), rated(1, "minor")), "Match");
  assert.equal(statusOf(severity.between("minor", "major"), rated(0, "trivial")), "Miss");
  assert.equal(statusOf(severity.between("minor", "major"), rated(2, "major")), "Match");
  assert.equal(statusOf(severity.between("minor", "major"), rated(3, "critical")), "Miss");
  assert.equal(statusOf(severity.is("major"), rated(2, "major")), "Match");
});

test("two cases that reuse a decision id for different definitions are refused when the policy is finished", () => {
  const OnChange = Discern.on(Schema.String);
  const a = OnChange.probability({ id: "risk", instructions: "Risky" });
  const b = OnChange.probability({ id: "risk", instructions: "Something else entirely" });
  const matcher = Discern.type(Schema.String).pipe(
    Discern.when(a.above(0.8), () => "a"),
    Discern.when(b.above(0.8), () => "b"),
  );

  assert.throws(
    () => matcher.pipe(Discern.orElse(() => "neither")),
    (error) => error instanceof Discern.DecisionIdCollisionError && error.decisionId === "risk",
  );

  // The same definition under the same id is one decision, not a collision.
  const again = OnChange.probability({ id: "risk", instructions: "Risky" });
  Discern.type(Schema.String).pipe(
    Discern.when(a.above(0.8), () => "a"),
    Discern.when(again.below(0.2), () => "b"),
    Discern.orElse(() => "neither"),
  );
});

test("a recording that decodes but holds an impossible answer fails on replay instead of deciding", async () => {
  const model = (options) => answersFor(options, () => probabilityAnswer(0.95));
  const risky = Discern.on(Schema.String).probability({ id: "risk", instructions: "Risky" });
  const policy = Discern.type(Schema.String).pipe(
    Discern.when(risky.above(0.8), () => "block"),
    Discern.orElse(() => "ship"),
  );
  const store = Model.store();
  await run(policy("x"), model, [Model.recording(store)]);

  // The schema checks the envelope; the answer inside is checked on replay.
  const tampered = JSON.parse(JSON.stringify(store.snapshot()));
  for (const entry of Object.values(tampered.entries)) entry.answer = { probability: 7 };
  const decoded = Schema.decodeUnknownSync(Model.Observations)(tampered);

  const invalidObservation = (error) =>
    Model.isInvalidObservation(error) &&
    !Model.isReplayMiss(error) &&
    /probability outside \[0, 1\]/.test(error.message);

  await assert.rejects(() => Effect.runPromise(policy.replay("x", decoded)), invalidObservation);

  // A cache loaded from the same file is read back through the same check,
  // and never falls through to the model to paper over the bad entry.
  let calls = 0;
  const counting = (options) => {
    calls += 1;
    return model(options);
  };
  await assert.rejects(() => run(policy("x"), counting, [Model.caching(Model.store(decoded))]), invalidObservation);
  assert.equal(calls, 0);
});

test("a recorded answer naming a label the decision does not have fails on replay", async () => {
  const model = (options) =>
    answersFor(options, () => classifyAnswer("breaking", { none: 0.1, breaking: 0.9 }));
  const impact = Discern.on(Schema.String).classify({
    id: "impact",
    instructions: "Impact",
    criteria: { none: "n", breaking: "b" },
  });
  const policy = Discern.match(impact).pipe(
    Discern.caseOf("none", () => "ship"),
    Discern.caseOf("breaking", () => "block"),
    Discern.exhaustive,
  );
  const store = Model.store();
  await run(policy("x"), model, [Model.recording(store)]);
  assert.equal(await Effect.runPromise(policy.replay("x", store.snapshot())), "block");

  const tampered = JSON.parse(JSON.stringify(store.snapshot()));
  for (const entry of Object.values(tampered.entries)) {
    entry.answer = { label: "catastrophic", probabilities: { none: 0.1, breaking: 0.9 } };
  }
  await assert.rejects(
    () => Effect.runPromise(policy.replay("x", Schema.decodeUnknownSync(Model.Observations)(tampered))),
    (error) => Model.isInvalidObservation(error) && /unknown label/.test(error.message),
  );
});

test("replay with fall-through checks the recorded half and asks the model for the rest", async () => {
  let asked = [];
  const model = (options) => {
    asked = Object.keys(options.decisions);
    return answersFor(options, () => probabilityAnswer(0.95));
  };
  const OnChange = Discern.on(Schema.String);
  const a = OnChange.probability({ id: "a", instructions: "First" });
  const b = OnChange.probability({ id: "b", instructions: "Second" });
  const first = Discern.type(Schema.String).pipe(
    Discern.when(a.above(0.8), () => "a"),
    Discern.orElse(() => "none"),
  );
  const both = Discern.type(Schema.String).pipe(
    Discern.when(Discern.and(a.above(0.8), b.above(0.8)), () => "both"),
    Discern.orElse(() => "none"),
  );
  const store = Model.store();
  await run(first("x"), model, [Model.recording(store)]);

  asked = [];
  const value = await run(both("x"), model, [Model.replaying(store.snapshot(), { onMissing: "ask" })]);
  assert.equal(value, "both");
  assert.deepEqual(asked, ["b"], "only the unrecorded decision reaches the model");
});

test("Eval.calibrate with one candidate returns it", async () => {
  const model = (options) => answersFor(options, () => probabilityAnswer(Number(options.state)));
  const risky = Discern.on(Schema.String).probability({ id: "risk", instructions: "Risky" });
  const result = await run(
    Discern.Eval.calibrate({
      schema: Schema.String,
      values: [0.6],
      pattern: (threshold) => risky.atLeast(threshold),
      examples: [
        { input: "0.9", expected: true },
        { input: "0.1", expected: false },
      ],
    }),
    model,
  );
  assert.equal(result.best.value, 0.6);
  assert.equal(result.results.length, 1);
});

test("a sweep whose candidates reuse one decision id for different definitions fails as a defect", async () => {
  let calls = 0;
  const model = (options) => {
    calls += 1;
    return answersFor(options, () => probabilityAnswer(0.9));
  };
  const OnChange = Discern.on(Schema.String);
  const effect = Discern.Eval.sweep({
    schema: Schema.String,
    values: [0.5, 0.7],
    // A new definition per value, all claiming the id "risk".
    pattern: (threshold) => OnChange.probability({ id: "risk", instructions: `Risky past ${threshold}` }).atLeast(threshold),
    examples: [{ input: "x", expected: true }],
  });

  await assert.rejects(
    () => run(effect, model),
    (error) => error instanceof Discern.DecisionIdCollisionError && error.decisionId === "risk",
  );
  assert.equal(calls, 0);
});

test("a rating between two levels satisfies neither atLeast the upper nor atMost the lower", () => {
  const severity = Discern.on(Schema.String).rate({
    id: "severity",
    instructions: "Severity",
    criteria: ["trivial", "minor", "major", "critical"],
  });
  // Weighted position 1.5, with `major` the most probable level.
  const halfway = {
    ...rateAnswer(1.5, { trivial: 0.05, minor: 0.4, major: 0.5, critical: 0.05 }),
    label: "major",
  };

  assert.equal(statusOf(severity.atLeast("major"), halfway), "Miss");
  assert.equal(statusOf(severity.atMost("minor"), halfway), "Miss");
  // The documented ways to place the gap.
  assert.equal(statusOf(severity.atLeast("minor"), halfway), "Match");
  assert.equal(statusOf(severity.atMost("major"), halfway), "Match");
  assert.equal(statusOf(severity.between("minor", "major"), halfway), "Match");
  // `is` reads the most probable level, not the position.
  assert.equal(statusOf(severity.is("major"), halfway), "Match");
});

test("a reversed range is refused when the pattern is built", () => {
  const OnChange = Discern.on(Schema.String);
  const risk = OnChange.probability({ id: "risk", instructions: "Risky" });
  const severity = OnChange.rate({
    id: "severity",
    instructions: "Severity",
    criteria: ["trivial", "minor", "major", "critical"],
  });
  const refused = (low, high) => (error) =>
    error instanceof Discern.InvalidRangeError && error.low === low && error.high === high;

  assert.throws(() => risk.between(0.6, 0.4), refused(0.6, 0.4));
  assert.throws(() => severity.between("major", "minor"), refused("major", "minor"));
  assert.throws(() => severity.between("critical", "trivial"), refused("critical", "trivial"));

  // Equal ends match exactly that value or level.
  const exactly = risk.between(0.5, 0.5);
  assert.equal(statusOf(exactly, probabilityAnswer(0.5)), "Match");
  assert.equal(statusOf(exactly, probabilityAnswer(0.51)), "Miss");
  const onlyMajor = severity.between("major", "major");
  const even = { trivial: 0.25, minor: 0.25, major: 0.25, critical: 0.25 };
  assert.equal(statusOf(onlyMajor, { ...rateAnswer(2, even), label: "major" }), "Match");
  assert.equal(statusOf(onlyMajor, { ...rateAnswer(1.5, even), label: "major" }), "Miss");
});
