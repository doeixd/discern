import assert from "node:assert/strict";
import test from "node:test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Discern from "../dist/index.js";
import * as Capability from "../dist/capability.js";

const { Model } = Discern;

const providerOf = (fn) =>
  Model.provider((options) =>
    Effect.map(
      Effect.promise(async () => fn(options)),
      (answers) => ({ answers, usage: { inputTokens: undefined, outputTokens: undefined } }),
    ),
  );

const run = (effect, fn, interceptors = []) =>
  Effect.runPromise(Effect.provide(effect, Model.layer(providerOf(fn), interceptors)));

/** A router that answers the routing classification with a fixed distribution. */
const routesTo = (probabilities) => (options) => {
  const answers = {};
  for (const [key, decision] of Object.entries(options.decisions)) {
    answers[key] =
      decision._tag === "Classify"
        ? {
            _tag: "Classify",
            label: Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0],
            probabilities,
          }
        : { _tag: "Probability", probability: 0.9 };
  }
  return answers;
};

const Request = Schema.String;

const find = Capability.make({
  id: "find",
  description: "Locate code relevant to a behavior, feature or concept",
  examples: ["Find where retries are implemented"],
  input: Request,
  run: (request) => Effect.succeed(`found:${request}`),
});

const review = Capability.make({
  id: "review",
  description: "Review a change for correctness and semantic risk",
  input: Request,
  run: (request) => Effect.succeed(`reviewed:${request}`),
});

const testGaps = Capability.make({
  id: "test-gaps",
  description: "Find behavior that lacks sufficient test coverage",
  input: Request,
  run: (request) => Effect.succeed(`gaps:${request}`),
});

test("a capability runs directly, with no model involved", async () => {
  assert.equal(await Effect.runPromise(find.run("retries")), "found:retries");
});

test("a registry routes a confident request to one capability", async () => {
  const code = Capability.registry(Request, [find, review, testGaps]);

  const result = await run(code.invoke("check my tests"), routesTo({ find: 0.05, review: 0.1, "test-gaps": 0.85 }));
  assert.equal(result, "gaps:check my tests");
});

test("routing exposes the whole distribution, not just the winner", async () => {
  const code = Capability.registry(Request, [find, review, testGaps]);

  const route = await run(code.route("where is auth"), routesTo({ find: 0.8, review: 0.15, "test-gaps": 0.05 }));
  assert.equal(route._tag, "Matched");
  assert.equal(route.id, "find");
  assert.equal(route.probability, 0.8);
  assert.equal(Math.round(route.margin * 100) / 100, 0.65);
  assert.deepEqual(
    route.ranked.map((candidate) => candidate.id),
    ["find", "review", "test-gaps"],
  );
});

test("a near-tie is Uncertain rather than a coin flip", async () => {
  const code = Capability.registry(Request, [find, review, testGaps]);
  const muddled = routesTo({ find: 0.31, review: 0.34, "test-gaps": 0.35 });

  const route = await run(code.route("do something"), muddled);
  assert.equal(route._tag, "Uncertain");
  assert.match(route.reason, /no capability reached 0\.7/);

  // Uncertainty is reported about the distribution, not about whichever
  // capability happens to be listed first.
  assert.deepEqual(
    route.ranked.map((candidate) => candidate.id),
    ["test-gaps", "review", "find"],
  );
});

test("a clear leader with too small a margin is still Uncertain", async () => {
  const code = Capability.registry(Request, [find, review, testGaps]);
  const close = routesTo({ find: 0.44, review: 0.46, "test-gaps": 0.1 });

  const route = await run(code.route("ambiguous", { minProbability: 0.4, minMargin: 0.15 }), close);
  assert.equal(route._tag, "Uncertain");
  assert.match(route.reason, /led find by only 0\.020/);
});

test("an unroutable request fails rather than guessing, unless handled", async () => {
  const code = Capability.registry(Request, [find, review, testGaps]);
  const muddled = routesTo({ find: 0.33, review: 0.34, "test-gaps": 0.33 });

  await assert.rejects(
    () => run(code.invoke("???"), muddled),
    (error) => (error?.cause ?? error)?._tag === "RoutingUncertainError",
  );

  const handled = await run(
    code.invoke("???", { onUncertain: (_input, route) => `ask-a-human:${route.ranked[0].id}` }),
    muddled,
  );
  assert.equal(handled, "ask-a-human:review");
});

test("thresholds are tunable per call", async () => {
  const code = Capability.registry(Request, [find, review, testGaps]);
  const leaning = routesTo({ find: 0.55, review: 0.3, "test-gaps": 0.15 });

  assert.equal((await run(code.route("x"), leaning))._tag, "Uncertain");

  const relaxed = await run(code.route("x", { minProbability: 0.5, minMargin: 0.2 }), leaning);
  assert.equal(relaxed._tag, "Matched");
  assert.equal(relaxed.id, "find");
});

test("the routing decision is an ordinary pattern, so Eval can measure it", async () => {
  const code = Capability.registry(Request, [find, review, testGaps]);

  // "Is this request for `find`?" evaluated over labeled examples.
  const isFind = code.decision.is("find", { match: 0.7, margin: 0.15 });
  const model = (options) =>
    routesTo(
      options.state === "where is auth"
        ? { find: 0.9, review: 0.05, "test-gaps": 0.05 }
        : { find: 0.05, review: 0.9, "test-gaps": 0.05 },
    )(options);

  const report = await run(
    Discern.Eval.run(Request, isFind, [
      { input: "where is auth", expected: true },
      { input: "review this diff", expected: false },
    ]),
    model,
  );

  assert.equal(report.metrics.accuracy, 1);
  assert.equal(report.metrics.uncertain, 0);
});

test("a registry rejects duplicate ids and single-member registries", () => {
  assert.throws(() => Capability.registry(Request, [find]), /at least two capabilities/);
  assert.throws(() => Capability.registry(Request, [find, find]), /Duplicate capability id "find"/);
});

test("observations are attributed to the capability that made them", async () => {
  const risky = Discern.on(Request).probability({ id: "risk", instructions: "Risky" });
  const riskPolicy = Discern.type(Request).pipe(
    Discern.when(risky.above(0.8), () => "risky"),
    Discern.orElse(() => "safe"),
  );

  const auditor = Capability.make({
    id: "audit",
    description: "Audit a change for risk",
    input: Request,
    run: (request) => Effect.map(riskPolicy(request), (verdict) => `${verdict}:${request}`),
  });
  const code = Capability.registry(Request, [auditor, find]);

  const observations = Model.store();
  const result = await run(
    code.invoke("deploy on friday"),
    (options) =>
      Object.keys(options.decisions).includes("risk")
        ? { risk: { _tag: "Probability", probability: 0.95 } }
        : routesTo({ audit: 0.9, find: 0.1 })(options),
    [Model.recording(observations)],
  );
  assert.equal(result, "risky:deploy on friday");

  const tree = Model.tree(observations.snapshot(), "invoke");
  // Routing is its own scope; the risk decision belongs to the capability that made it.
  assert.deepEqual(tree.observations, []);
  assert.deepEqual(
    tree.children.map((child) => [child.name, child.observations.map((o) => o.decisionId)]),
    [
      ["route", [code.decision.id]],
      ["audit", ["risk"]],
    ],
  );
});

test("a whole capability invocation replays from one recording", async () => {
  let calls = 0;
  const urgent = Discern.on(Request).probability({ id: "urgent", instructions: "Urgent" });
  const urgency = Discern.type(Request).pipe(
    Discern.when(urgent.above(0.8), () => "now"),
    Discern.orElse(() => "later"),
  );
  const triage = Capability.make({
    id: "triage",
    description: "Decide how soon a request needs attention",
    input: Request,
    run: (request) => Effect.map(urgency(request), (when) => `${when}:${request}`),
  });
  const code = Capability.registry(Request, [triage, find]);

  const model = (options) => {
    calls += 1;
    return Object.keys(options.decisions).includes("urgent")
      ? { urgent: { _tag: "Probability", probability: 0.95 } }
      : routesTo({ triage: 0.9, find: 0.1 })(options);
  };

  const observations = Model.store();
  assert.equal(
    await run(code.invoke("prod is down"), model, [Model.recording(observations)]),
    "now:prod is down",
  );
  assert.equal(calls, 2, "one call to route, one inside the capability");

  const replayed = await Effect.runPromise(
    Effect.provide(code.invoke("prod is down"), Model.replayLayer(observations.snapshot())),
  );
  assert.equal(replayed, "now:prod is down");
  assert.equal(calls, 2, "routing and the capability body both replayed");
});

test("get rejects an id the registry does not have", () => {
  const code = Capability.registry(Request, [find, review]);
  assert.equal(code.get("find"), find);
  assert.throws(() => code.get("nope"), /No capability "nope" in this registry \(have: find, review\)/);
});
