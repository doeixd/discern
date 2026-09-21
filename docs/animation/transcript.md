# From Jev to composed programs

Narrated Manim tutorial. All model outputs and thresholds are illustrative.

## 00:00:00 — Jev: a model that makes focused judgments

Start with Jev, TypeSafe's AI model for focused judgments. You give it context and a question. It returns a typed answer that your code can use.

Here is the change we will follow: remove a deprecated retry field. Give Jev the summary and diff, and ask whether this change will cause a regression.

Suppose its answer is point six two: an estimated sixty-two percent probability of a regression. This is an illustrative estimate. It does not tell our application whether to block the release.

## 00:00:37 — Choose the kind of answer you need

Jev supports three question types. Noul gives the probability of yes. Choice compares named alternatives. Score places the input along described, ordered levels.

For our change, these could mean regression risk, breaking versus compatible, and severity. We define the questions and answer spaces. Jev supplies the judgments.

## 00:01:04 — Decision defines the question in Effect

Now bring that capability into Effect, the TypeScript library that runs our program. Effect's Decision describes a question and its answer type. Creating this value does not call Jev.

The names in Effect are probability, classify, and rate. The TypeSafe adapter maps them to Jev's Noul, Choice, and Score. These are two vocabularies for the same kinds of questions.

## 00:01:33 — DecisionModel asks the provider

DecisionModel is the service that actually answers those questions. We pass it an input and our decision definitions. A TypeSafe provider connects this service to Jev.

The answer comes back as typed data: risk, probability, point six two. Decision defines what to ask; DecisionModel supplies the answer. Discern can use other DecisionModel providers too.

## 00:02:01 — An observation still needs a policy

We now have a number, but our application needs an action. If we only ask whether risk is at least point eight, point six two becomes false.

A fallback might then ship the change. But below our blocking threshold does not mean safe. We need a way to represent the gap between enough evidence for yes and enough for no.

## 00:02:24 — Discern turns evidence into a pattern

Discern adds that interpretation. We declare the same risk question through Discern, then create a pattern with a match threshold and a separate miss threshold.

At point nine, this pattern matches: there is enough evidence for high risk.

At point two, it misses: the high-risk condition is not met.

Our point six two lies between point five and point eight. The result is Uncertain. These thresholds are application policy; they are not chosen by Jev.

## 00:02:59 — A policy turns pattern results into actions

Now connect those three results to code. When high risk matches, return block. When it is uncertain, return human review. If every rule misses, return ship.

Follow our change: point six two makes the first rule uncertain, so human review runs. Evaluation stops there. The ship fallback is never reached.

This is a deliberately small release policy. Discern makes our thresholds and branches explicit. It does not prove that the model's estimate, or our release policy, is correct.

## 00:03:39 — More rules can reuse the same evidence

We can add an impact question and combine patterns. First, block changes that are both breaking and high risk. Otherwise, a confidently breaking change can require a migration.

Both rules refer to breaking, but Discern asks about impact only once. The required impact and risk questions share one model call for this input. The rules reuse their answers.

Order still matters. If the first rule is uncertain, it stops at human review. It does not skip ahead to the migration rule.

## 00:04:17 — A Procedure gives a program a name

Our review policy is useful on its own. A Procedure wraps a program with a name, description, and input schema, so it can also be discovered and selected.

The request contains an ask and the same change. The review procedure passes that change to our simpler review policy. Its run function is ordinary Effect code.

When we already want a review, call run directly. That adds no routing call. The review policy inside still asks the model for risk.

## 00:04:51 — A registry selects a procedure from intent

Now add an explain procedure, which returns the supplied summary. Put review and explain in a registry. Both accept the same request shape.

For the request, is this safe to ship, the registry asks a classification question built from the procedure descriptions. Suppose review receives point nine two, and explain point zero eight.

Invoke selects review and passes the original request to its run function. Routing chooses an existing program. Your code supplies the arguments and controls what that program does.

## 00:05:29 — An unclear request can remain unresolved

Change the ask to, can you look at this. Suppose the scores become point five two and point four eight. Review leads, but that tiny lead is not enough.

With the default probability and margin requirements, routing is uncertain. Our explicit handler asks the user to clarify. Neither procedure runs. Without a handler, invocation fails with a routing uncertainty error.

## 00:05:59 — Complex programs grow from these pieces

For a larger assistant, wrap the change registry as a code procedure. Place code alongside help in a top-level registry. A registry can now route into another registry.

Follow the original request again. The first routing judgment chooses code. The second chooses review. The selected review program asks for risk and returns human review for point six two.

That is three model calls along this illustrated path: two routing classifications and one risk judgment. Each level has a specific job, and uncertainty can stop execution at that level.

Known sequences need no extra router: Effect code can call review, then explain. For nested routing, set a depth limit. Record observations to inspect the execution tree or replay those judgments.

## 00:06:55 — The layers, from judgment to program

Jev produces a judgment. Decision describes the question, and DecisionModel connects it to a provider. Discern interprets the evidence and selects an explicit branch.

Procedures package programs. Registries choose among them and can nest. Start with one useful question, make its uncertainty policy explicit, then compose the behavior your application needs.

## Sources

- [TypeSafe: System One and Jev](https://docs.typesafe.ai/concepts/system-one)
- [TypeSafe question types](https://docs.typesafe.ai/primitives)
- [Typechecked example](../../examples/explainer.ts)
- [Discern implementation](../../src/index.ts)
- [Procedure implementation](../../src/procedure.ts)
