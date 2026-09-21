# From Jev to composed programs

Silent Manim tutorial with on-screen explanations. All model outputs and thresholds are illustrative.

## 00:00:00 — Jev: a model that makes focused judgments

Jev is TypeSafe's AI model for focused judgments. Give it context and a question; get a typed answer.

Example: remove a deprecated retry field. Ask Jev whether this change will cause a regression.

Illustrative answer: 0.62 probability of a regression. Your application still needs to decide what to do.

## 00:00:15 — Choose the kind of answer you need

Noul: probability of yes. Choice: named alternatives. Score: ordered levels.

For this change: regression risk, API impact, and severity. You define the questions; Jev supplies judgments.

## 00:00:24 — Decision defines the question in Effect

Effect's Decision defines a question and its answer type. Creating it does not call the model.

The TypeSafe adapter maps Effect's probability, classify, and rate to Jev's Noul, Choice, and Score.

## 00:00:33 — DecisionModel asks the provider

DecisionModel sends your questions and input to a provider. Here, the TypeSafe provider connects to Jev.

The result is typed evidence. Decision defines the question; DecisionModel answers it. Other providers work too.

## 00:00:44 — An observation still needs a policy

A simple threshold turns 0.62 into false: it is below 0.80.

A fallback might ship. But below the blocking threshold does not mean safe. What about the uncertainty?

## 00:00:53 — Discern turns evidence into a pattern

Discern adds an interpretation: one threshold for Match, another for Miss, and Uncertain between them.

0.90 → Match: enough evidence for high risk.

0.20 → Miss: the high-risk condition is not met.

0.62 → Uncertain: between 0.50 and 0.80. Your policy sets these thresholds.

## 00:01:08 — A policy turns pattern results into actions

Connect results to actions: Match → block. Uncertain → human-review. All rules miss → ship.

Our change takes human-review. The uncertain rule stops evaluation before the ship fallback.

This is an example policy. Choose and evaluate thresholds for your application.

## 00:01:20 — More rules can reuse the same evidence

Combine patterns: breaking AND high risk → block. Otherwise, a confidently breaking change can require migration.

Impact appears in both rules but is asked once. Required impact and risk questions share one model call.

Order matters: an uncertain first rule stops at human-review, before the migration rule.

## 00:01:35 — A Procedure gives a program a name

A Procedure wraps a program with a name, description, and input schema.

This procedure passes the request's change to our simpler review policy. Its body is ordinary Effect code.

Call run directly when you know what you want. No routing call; the review body still asks for risk.

## 00:01:50 — A registry selects a procedure from intent

A registry groups procedures with the same input type. Here: review a change or return its supplied summary.

The registry classifies intent using procedure descriptions. This clear request strongly favors review.

Invoke selects review and passes the original request to run. Your code supplies arguments and performs the work.

## 00:02:05 — An unclear request can remain unresolved

A vague request produces a near tie. The highest score alone does not justify running a procedure.

Neither threshold is met. Our onUncertain handler requests clarification; neither procedure runs.

## 00:02:14 — Complex programs grow from these pieces

Wrap a registry as a procedure with fromRegistry. Then place it inside another registry.

Follow the request: assistant selects code, code selects review, and review returns human-review for risk 0.62.

Three calls on this path: two routing classifications, then one risk judgment. Uncertainty can stop any level.

Compose known sequences directly in Effect. Limit nested routing depth; record observations to inspect and replay.

## 00:02:33 — The layers, from judgment to program

Jev judges. Decision defines the question. DecisionModel asks a provider. Discern interprets evidence and selects a branch.

Procedures package programs. Registries select and compose them. Start with one question, then build up.

## Sources

- [TypeSafe: System One and Jev](https://docs.typesafe.ai/concepts/system-one)
- [TypeSafe question types](https://docs.typesafe.ai/primitives)
- [Typechecked example](../../examples/explainer.ts)
- [Discern implementation](../../src/index.ts)
- [Procedure implementation](../../src/procedure.ts)
