import assert from "node:assert/strict";
import test from "node:test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Discern from "../dist/index.js";
import * as Procedure from "../dist/procedure.js";

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

/**
 * A router that answers the routing classification from a table of preferences.
 *
 * Eligibility can narrow the labels a decision actually carries, so the answer
 * is restricted to whatever was asked about and renormalised. A table that
 * already covers exactly those labels is used verbatim, to keep probabilities
 * exact for assertions.
 */
const routesTo = (preferences) => (options) => {
  const answers = {};
  for (const [key, decision] of Object.entries(options.decisions)) {
    if (decision._tag !== "Classify") {
      answers[key] = { _tag: "Probability", probability: 0.9 };
      continue;
    }
    const labels = Object.keys(decision.criteria);
    const exact =
      Object.keys(preferences).length === labels.length &&
      labels.every((label) => Object.hasOwn(preferences, label));
    let probabilities;
    if (exact) {
      probabilities = preferences;
    } else {
      const weights = labels.map((label) => (Object.hasOwn(preferences, label) ? preferences[label] : 0));
      const total = weights.reduce((sum, weight) => sum + weight, 0);
      probabilities = Object.fromEntries(
        labels.map((label, index) => [
          label,
          total === 0 ? 1 / labels.length : weights[index] / total,
        ]),
      );
    }
    const label = labels.reduce(
      (best, candidate) => (probabilities[candidate] > probabilities[best] ? candidate : best),
      labels[0],
    );
    answers[key] = { _tag: "Classify", label, probabilities };
  }
  return answers;
};

const Request = Schema.String;

const find = Procedure.make({
  id: "find",
  description: "Locate code relevant to a behavior, feature or concept",
  examples: ["Find where retries are implemented"],
  input: Request,
  run: (request) => Effect.succeed(`found:${request}`),
});

const review = Procedure.make({
  id: "review",
  description: "Review a change for correctness and semantic risk",
  input: Request,
  run: (request) => Effect.succeed(`reviewed:${request}`),
});

const testGaps = Procedure.make({
  id: "test-gaps",
  description: "Find behavior that lacks sufficient test coverage",
  input: Request,
  run: (request) => Effect.succeed(`gaps:${request}`),
});

test("a procedure runs directly, with no model involved", async () => {
  assert.equal(await Effect.runPromise(find.run("retries")), "found:retries");
});

test("a registry routes a confident request to one procedure", async () => {
  const code = Procedure.registry(Request, [find, review, testGaps]);

  const result = await run(code.invoke("check my tests"), routesTo({ find: 0.05, review: 0.1, "test-gaps": 0.85 }));
  assert.equal(result, "gaps:check my tests");
});

test("routing exposes the whole distribution, not just the winner", async () => {
  const code = Procedure.registry(Request, [find, review, testGaps]);

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
  const code = Procedure.registry(Request, [find, review, testGaps]);
  const muddled = routesTo({ find: 0.31, review: 0.34, "test-gaps": 0.35 });

  const route = await run(code.route("do something"), muddled);
  assert.equal(route._tag, "Uncertain");
  assert.match(route.reason, /no procedure reached 0\.7/);

  // Uncertainty is reported about the distribution, not about whichever
  // procedure happens to be listed first.
  assert.deepEqual(
    route.ranked.map((candidate) => candidate.id),
    ["test-gaps", "review", "find"],
  );
});

test("a clear leader with too small a margin is still Uncertain", async () => {
  const code = Procedure.registry(Request, [find, review, testGaps]);
  const close = routesTo({ find: 0.44, review: 0.46, "test-gaps": 0.1 });

  const route = await run(code.route("ambiguous", { minProbability: 0.4, minMargin: 0.15 }), close);
  assert.equal(route._tag, "Uncertain");
  assert.match(route.reason, /led find by only 0\.020/);
});

test("an unroutable request fails rather than guessing, unless handled", async () => {
  const code = Procedure.registry(Request, [find, review, testGaps]);
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
  const code = Procedure.registry(Request, [find, review, testGaps]);
  const leaning = routesTo({ find: 0.55, review: 0.3, "test-gaps": 0.15 });

  assert.equal((await run(code.route("x"), leaning))._tag, "Uncertain");

  const relaxed = await run(code.route("x", { minProbability: 0.5, minMargin: 0.2 }), leaning);
  assert.equal(relaxed._tag, "Matched");
  assert.equal(relaxed.id, "find");
});

test("the routing decision is an ordinary pattern, so Eval can measure it", async () => {
  const code = Procedure.registry(Request, [find, review, testGaps]);

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
  assert.throws(() => Procedure.registry(Request, [find]), /at least two procedures/);
  assert.throws(() => Procedure.registry(Request, [find, find]), /Duplicate procedure id "find"/);
});

test("observations are attributed to the procedure that made them", async () => {
  const risky = Discern.on(Request).probability({ id: "risk", instructions: "Risky" });
  const riskPolicy = Discern.type(Request).pipe(
    Discern.when(risky.above(0.8), () => "risky"),
    Discern.orElse(() => "safe"),
  );

  const auditor = Procedure.make({
    id: "audit",
    description: "Audit a change for risk",
    input: Request,
    run: (request) => Effect.map(riskPolicy(request), (verdict) => `${verdict}:${request}`),
  });
  const code = Procedure.registry(Request, [auditor, find]);

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
  // Routing is its own scope; the risk decision belongs to the procedure that made it.
  assert.deepEqual(tree.observations, []);
  assert.deepEqual(
    tree.children.map((child) => [child.name, child.observations.map((o) => o.decisionId)]),
    [
      ["route", [code.decision.id]],
      ["audit", ["risk"]],
    ],
  );
});

test("a whole procedure invocation replays from one recording", async () => {
  let calls = 0;
  const urgent = Discern.on(Request).probability({ id: "urgent", instructions: "Urgent" });
  const urgency = Discern.type(Request).pipe(
    Discern.when(urgent.above(0.8), () => "now"),
    Discern.orElse(() => "later"),
  );
  const triage = Procedure.make({
    id: "triage",
    description: "Decide how soon a request needs attention",
    input: Request,
    run: (request) => Effect.map(urgency(request), (when) => `${when}:${request}`),
  });
  const code = Procedure.registry(Request, [triage, find]);

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
  assert.equal(calls, 2, "one call to route, one inside the procedure");

  const replayed = await Effect.runPromise(
    Effect.provide(code.invoke("prod is down"), Model.replayLayer(observations.snapshot())),
  );
  assert.equal(replayed, "now:prod is down");
  assert.equal(calls, 2, "routing and the procedure body both replayed");
});

test("get rejects an id the registry does not have", () => {
  const code = Procedure.registry(Request, [find, review]);
  assert.equal(code.get("find"), find);
  assert.throws(() => code.get("nope"), /No procedure "nope" in this registry \(have: find, review\)/);
});

test("an id that collides with Object.prototype still routes", async () => {
  // Assigning `__proto__` on a plain object literal sets no own property, so a
  // procedure named this way would vanish from the routing criteria.
  const odd = Procedure.make({
    id: "__proto__",
    description: "A procedure with an awkward name",
    input: Request,
    run: () => Effect.succeed("odd"),
  });
  const code = Procedure.registry(Request, [odd, find]);

  assert.deepEqual(Object.keys(code.decision.decision.criteria), ["__proto__", "find"]);

  // The distribution has to be built the same careful way, or the fake provider
  // reproduces the very bug this covers.
  const probabilities = Object.fromEntries([
    ["__proto__", 0.9],
    ["find", 0.1],
  ]);
  const result = await run(code.invoke("x"), routesTo(probabilities));
  assert.equal(result, "odd");
});

test("registries nest, so each routing decision stays a short question", async () => {
  const lint = Procedure.make({
    id: "lint",
    description: "Check style and formatting",
    input: Request,
    run: () => Effect.succeed("linted"),
  });

  // A group of code procedures, presented to the parent as one entry.
  const codeGroup = Procedure.registry(Request, [find, review], { id: "code-route" });
  const code = Procedure.fromRegistry({
    id: "code",
    description: "Anything about reading or reviewing source code",
    registry: codeGroup,
  });
  const top = Procedure.registry(Request, [code, lint], { id: "top-route" });

  const calls = [];
  const model = (options) => {
    const decisionId = Object.keys(options.decisions)[0];
    calls.push(decisionId);
    return routesTo(decisionId === "top-route" ? { code: 0.9, lint: 0.1 } : { find: 0.05, review: 0.95 })(
      options,
    );
  };

  const observations = Model.store();
  assert.equal(
    await run(top.invoke("is this diff safe"), model, [Model.recording(observations)]),
    "reviewed:is this diff safe",
  );
  assert.deepEqual(calls, ["top-route", "code-route"], "one decision per level, not one big one");

  const tree = Model.tree(observations.snapshot(), "top");
  assert.deepEqual(
    tree.children.map((child) => child.name),
    ["route", "code"],
  );
  assert.deepEqual(
    tree.children[1].children.map((child) => child.name),
    ["route"],
  );
});

test("nested invocation is bounded by a depth limit", async () => {
  let registry;
  const loop = Procedure.make({
    id: "loop",
    description: "Routes straight back to the registry it belongs to",
    input: Request,
    run: (request) => registry.invoke(request),
  });
  registry = Procedure.registry(Request, [loop, find]);

  let calls = 0;
  const model = (options) => {
    calls += 1;
    return routesTo({ loop: 0.95, find: 0.05 })(options);
  };

  await assert.rejects(
    () => run(Procedure.withMaxDepth(3)(registry.invoke("x")), model),
    (error) => {
      const cause = error?.cause ?? error;
      return cause?._tag === "DepthExceededError" && cause.limit === 3;
    },
  );
  assert.equal(calls, 3, "routing stops at the limit rather than recursing forever");
});

test("depth is per-branch, not a running total", async () => {
  // Two sibling invocations each start from the caller's depth.
  const codeGroup = Procedure.registry(Request, [find, review], { id: "inner" });
  const model = routesTo({ find: 0.9, review: 0.1 });

  const both = Effect.all([codeGroup.invoke("a"), codeGroup.invoke("b")]);
  assert.deepEqual(await run(Procedure.withMaxDepth(1)(both), model), ["found:a", "found:b"]);
});

// -------------------------------------------------------------------------------------------------
// Routing projection, eligibility and route telemetry
// -------------------------------------------------------------------------------------------------

const Ticket = Schema.Struct({
  ask: Schema.String,
  environment: Schema.String,
  evidence: Schema.String,
});

const ticket = (ask, environment = "production", evidence = "a very large blob") => ({
  ask,
  environment,
  evidence,
});

const inspect = Procedure.make({
  id: "inspect",
  description: "Look at what a ticket is about",
  input: Ticket,
  run: (request) => Effect.succeed(`inspected:${request.ask}`),
});

const deploy = Procedure.make({
  id: "deploy",
  description: "Release the change described by a ticket",
  input: Ticket,
  eligible: (request) => request.environment !== "local",
  run: (request) => Effect.succeed(`deployed:${request.environment}`),
});

const escalate = Procedure.make({
  id: "escalate",
  description: "Hand the ticket to a human",
  input: Ticket,
  run: () => Effect.succeed("escalated"),
});

const rollback = Procedure.make({
  id: "rollback",
  description: "Undo the last release",
  input: Ticket,
  eligible: (request) => request.environment !== "local",
  run: () => Effect.succeed("rolled-back"),
});

test("routing can be projected, so evidence stays out of the prompt", async () => {
  let seen;
  const model = (options) => {
    seen = options.state;
    return routesTo({ inspect: 0.9, deploy: 0.05, rollback: 0.05 })(options);
  };

  const projected = Procedure.registry(Ticket, [inspect, deploy, rollback], {
    routeBy: { schema: Schema.String, select: (request) => request.ask },
  });

  const result = await run(projected.invoke(ticket("what is this about?")), model);
  assert.equal(result, "inspected:what is this about?");
  assert.equal(seen, "what is this about?", "the router saw only the projection");
  assert.equal(projected.routeInput, Schema.String);
});

test("without a projection the router sees the whole input", async () => {
  let seen;
  const model = (options) => {
    seen = options.state;
    return routesTo({ inspect: 0.9, deploy: 0.05, rollback: 0.05 })(options);
  };

  const whole = Procedure.registry(Ticket, [inspect, deploy, rollback]);
  await run(whole.invoke(ticket("what is this about?")), model);
  assert.equal(seen.evidence, "a very large blob");
});

test("ineligible procedures are removed before the model is asked", async () => {
  let asked;
  const model = (options) => {
    asked = Object.keys(Object.values(options.decisions)[0].criteria);
    return routesTo({ inspect: 0.9, deploy: 0.04, rollback: 0.03, escalate: 0.03 })(options);
  };

  const registry = Procedure.registry(Ticket, [inspect, deploy, rollback, escalate], {
    routeBy: { schema: Schema.String, select: (request) => request.ask },
  });

  await run(registry.invoke(ticket("what is this?", "production")), model);
  assert.deepEqual(asked, ["inspect", "deploy", "rollback", "escalate"]);

  await run(registry.invoke(ticket("what is this?", "local")), model);
  assert.deepEqual(asked, ["inspect", "escalate"], "deploy and rollback are not offered locally");
});

test("a single eligible procedure is routed to without a model call", async () => {
  let calls = 0;
  const model = (options) => {
    calls += 1;
    return routesTo({ deploy: 0.5, rollback: 0.5 })(options);
  };

  const releases = Procedure.registry(Ticket, [deploy, rollback], {
    routeBy: { schema: Schema.String, select: (request) => request.ask },
  });

  // Locally neither is eligible.
  await assert.rejects(
    () => run(releases.invoke(ticket("ship it", "local")), model),
    (error) => (error?.cause ?? error)?._tag === "NoEligibleProcedureError",
  );
  assert.equal(calls, 0);

  // Narrow to exactly one and the question answers itself.
  const onlyDeploy = Procedure.registry(Ticket, [deploy, inspect], {
    routeBy: { schema: Schema.String, select: (request) => request.ask },
  });
  const route = await run(
    onlyDeploy.route(ticket("ship it", "local")),
    model,
  );
  assert.equal(route._tag, "Matched");
  assert.equal(route.id, "inspect");
  assert.equal(route.by, "elimination");
  assert.equal(calls, 0, "elimination costs nothing");
});

test("invokeWithRoute exposes the selection alongside the result", async () => {
  const model = routesTo({ inspect: 0.05, deploy: 0.9, rollback: 0.05 });
  const registry = Procedure.registry(Ticket, [inspect, deploy, rollback], {
    routeBy: { schema: Schema.String, select: (request) => request.ask },
  });

  const { route, value } = await run(
    registry.invokeWithRoute(ticket("please release this")),
    model,
  );
  assert.equal(value, "deployed:production");
  assert.equal(route._tag, "Matched");
  assert.equal(route.id, "deploy");
  assert.equal(route.by, "model");
  assert.equal(route.probability, 0.9);
  assert.deepEqual(
    route.ranked.map((candidate) => candidate.id),
    ["deploy", "inspect", "rollback"],
  );
});

test("a projected route is addressed by the projection, so evidence does not split the cache", async () => {
  let calls = 0;
  const model = (options) => {
    calls += 1;
    return routesTo({ inspect: 0.9, deploy: 0.05, rollback: 0.05 })(options);
  };

  const registry = Procedure.registry(Ticket, [inspect, deploy, rollback], {
    routeBy: { schema: Schema.String, select: (request) => request.ask },
  });

  const store = Model.store();
  const cache = [Model.caching(store)];
  await run(registry.invoke(ticket("what is this?", "production", "diff A")), model, cache);
  await run(registry.invoke(ticket("what is this?", "production", "diff B")), model, cache);
  assert.equal(calls, 1, "the same question about different evidence reuses the routing answer");
});
