/**
 * Discern — semantic pattern matching and control flow for Effect DecisionModel.
 *
 * Effect provides typed semantic observations through Decision / DecisionModel.
 * Discern turns those observations into uncertainty-aware patterns, Match-style
 * control flow, inspectable plans, traces, replay, caching and evaluation.
 */
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import * as AiError from "effect/unstable/ai/AiError";
import * as Decision from "effect/unstable/ai/Decision";
import * as DecisionModel from "effect/unstable/ai/DecisionModel";

// -------------------------------------------------------------------------------------------------
// Utilities
// -------------------------------------------------------------------------------------------------

const DecisionNodeTypeId: unique symbol = Symbol.for("discern/DecisionNode");
const PatternTypeId: unique symbol = Symbol.for("discern/Pattern");
const ProgramTypeId: unique symbol = Symbol.for("discern/Program");

const stable = (value: unknown): string => {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
    .join(",")}}`;
};

/**
 * Two independently seeded FNV-1a lanes, concatenated. Fingerprints gate replay
 * and cache reuse, so 32 bits is not enough margin to treat a match as proof
 * that a decision definition is unchanged.
 */
const hash = (value: unknown): string => {
  const input = typeof value === "string" ? value : stable(value);
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x85ebca6b);
  }
  return `${(a >>> 0).toString(36)}${(b >>> 0).toString(36).padStart(7, "0")}`;
};

const pipe = (self: unknown, fns: ReadonlyArray<(value: any) => any>): any => {
  let out = self;
  for (const fn of fns) out = fn(out);
  return out;
};

interface Pipeable {
  pipe<A>(ab: (self: this) => A): A;
  pipe<A, B>(ab: (self: this) => A, bc: (a: A) => B): B;
  pipe<A, B, C>(ab: (self: this) => A, bc: (a: A) => B, cd: (b: B) => C): C;
  pipe<A, B, C, D>(
    ab: (self: this) => A,
    bc: (a: A) => B,
    cd: (b: B) => C,
    de: (c: C) => D,
  ): D;
  pipe<A, B, C, D, E>(
    ab: (self: this) => A,
    bc: (a: A) => B,
    cd: (b: B) => C,
    de: (c: C) => D,
    ef: (d: D) => E,
  ): E;
  pipe<A, B, C, D, E, F>(
    ab: (self: this) => A,
    bc: (a: A) => B,
    cd: (b: B) => C,
    de: (c: C) => D,
    ef: (d: D) => E,
    fg: (e: E) => F,
  ): F;
}

type EffectSuccess<T> = T extends Effect.Effect<infer A, any, any> ? A : T;
type EffectError<T> = T extends Effect.Effect<any, infer E, any> ? E : never;
type EffectRequirements<T> = T extends Effect.Effect<any, any, infer R> ? R : never;

type Handler<Input, Result> = (input: Input) => Result;

const asEffect = <A>(value: A): Effect.Effect<EffectSuccess<A>, EffectError<A>, EffectRequirements<A>> =>
  (Effect.isEffect(value) ? value : Effect.succeed(value)) as any;

const effectAllSequential = <A, B, E, R>(
  values: ReadonlyArray<A>,
  f: (value: A, index: number) => Effect.Effect<B, E, R>,
): Effect.Effect<ReadonlyArray<B>, E, R> => {
  let current = Effect.succeed([] as Array<B>) as Effect.Effect<Array<B>, E, R>;
  values.forEach((value, index) => {
    current = Effect.flatMap(current, (out) =>
      Effect.map(f(value, index), (next) => {
        out.push(next);
        return out;
      }),
    ) as any;
  });
  return current as any;
};

// -------------------------------------------------------------------------------------------------
// Semantic results & errors
// -------------------------------------------------------------------------------------------------

export type PatternStatus = "Match" | "Miss" | "Uncertain";

export interface PatternResult {
  readonly _tag: PatternStatus;
  readonly reason?: string | undefined;
}

export const matched = (reason?: string): PatternResult => ({
  _tag: "Match",
  ...(reason === undefined ? undefined : { reason }),
});

export const missed = (reason?: string): PatternResult => ({
  _tag: "Miss",
  ...(reason === undefined ? undefined : { reason }),
});

export const uncertain = (reason?: string): PatternResult => ({
  _tag: "Uncertain",
  ...(reason === undefined ? undefined : { reason }),
});

export class UncertainMatchError extends Error {
  readonly _tag = "UncertainMatchError";
  override readonly name = "UncertainMatchError";
  constructor(
    readonly caseId: string,
    readonly reason?: string,
  ) {
    super(`Semantic case "${caseId}" was uncertain${reason ? `: ${reason}` : ""}`);
  }
}

export class ReplayMismatchError extends Error {
  readonly _tag = "ReplayMismatchError";
  override readonly name = "ReplayMismatchError";
  constructor(message: string) {
    super(message);
  }
}

export class ExhaustiveMatchError extends Error {
  readonly _tag = "ExhaustiveMatchError";
  override readonly name = "ExhaustiveMatchError";
  constructor() {
    super("A supposedly exhaustive semantic classification had no matching case");
  }
}

export type DiscernError = UncertainMatchError | ReplayMismatchError | ExhaustiveMatchError;

// -------------------------------------------------------------------------------------------------
// Decisions
// -------------------------------------------------------------------------------------------------

export type AnyDecision = Decision.Any;
export type Answer<D extends AnyDecision> = Decision.Answer<D>;

type AnswerLookup = Readonly<Record<string, unknown>>;

type DecisionOptions = {
  readonly id?: string | undefined;
};

export interface DecisionNode<Input, D extends AnyDecision, S extends Schema.Constraint | undefined = undefined> {
  readonly [DecisionNodeTypeId]: typeof DecisionNodeTypeId;
  readonly id: string;
  readonly fingerprint: string;
  readonly decision: D;
  readonly schema: S;
  /** A binary custom interpretation. Prefer `whereResult` when uncertainty matters. */
  readonly where: (
    predicate: (answer: Answer<D>) => boolean,
    options?: { readonly id?: string; readonly description?: string },
  ) => Pattern<Input>;
  /** A custom tri-state interpretation of this semantic answer. */
  readonly whereResult: (
    predicate: (answer: Answer<D>) => PatternResult,
    options?: { readonly id?: string; readonly description?: string },
  ) => Pattern<Input>;
}

type AnyDecisionNode = DecisionNode<any, AnyDecision, Schema.Constraint | undefined>;

const decisionFingerprint = (value: AnyDecision): string => `df_${hash(value)}`;

const makeDecisionNode = <Input, D extends AnyDecision, S extends Schema.Constraint | undefined>(
  value: D,
  schema: S,
  explicitId?: string,
): DecisionNode<Input, D, S> => {
  const fingerprint = decisionFingerprint(value);
  const id = explicitId ?? `d_${fingerprint.slice(3)}`;
  const node = {
    [DecisionNodeTypeId]: DecisionNodeTypeId,
    id,
    fingerprint,
    decision: value,
    schema,
  } as DecisionNode<Input, D, S>;

  return Object.assign(node, {
    where: (
      predicate: (answer: Answer<D>) => boolean,
      options: { readonly id?: string; readonly description?: string } = {},
    ) =>
      semanticLeaf<Input>(
        node as AnyDecisionNode,
        (answer) => (predicate(answer as Answer<D>) ? matched() : missed()),
        options,
      ),
    whereResult: (
      predicate: (answer: Answer<D>) => PatternResult,
      options: { readonly id?: string; readonly description?: string } = {},
    ) => semanticLeaf<Input>(node as AnyDecisionNode, (answer) => predicate(answer as Answer<D>), options),
  });
};

/** Wrap an Effect Decision. Supply a schema to make it executable on its own. */
export const decision = <D extends AnyDecision>(
  value: D,
  options: DecisionOptions = {},
): DecisionNode<any, D> => makeDecisionNode<any, D, undefined>(value, undefined, options.id);

export interface ClassifyThresholds {
  /** Probability at or above which the requested label is a match. */
  readonly match?: number | undefined;
  /** Probability at or below which the requested label is a miss. Between miss and match is uncertain. */
  readonly miss?: number | undefined;
  /** Optional minimum margin over the runner-up label before matching. */
  readonly margin?: number | undefined;
}

export interface ClassifyDecision<
  Input,
  Label extends string,
  S extends Schema.Constraint | undefined = undefined,
> extends DecisionNode<Input, Decision.Classify<Label>, S> {
  readonly labels: ReadonlyArray<Label>;
  readonly is: (label: Label, thresholds?: ClassifyThresholds) => Pattern<Input>;
  readonly oneOf: (...labels: ReadonlyArray<Label>) => Pattern<Input>;
  readonly not: (label: Label) => Pattern<Input>;
  readonly margin: (label: Label, over: Label, by: number) => Pattern<Input>;
}

const classifyFor = <Input, Label extends string, S extends Schema.Constraint | undefined>(
  options: {
    readonly id?: string;
    readonly instructions: string;
    readonly criteria: { readonly [L in Label]: string };
  },
  schema: S,
): ClassifyDecision<Input, Label, S> => {
  const { id, ...definition } = options;
  const node = makeDecisionNode<Input, Decision.Classify<Label>, S>(Decision.classify(definition), schema, id);
  const labels = Object.keys(options.criteria) as Array<Label>;
  const is = (label: Label, thresholds?: ClassifyThresholds): Pattern<Input> => {
    if (thresholds === undefined) {
      return node.where((answer) => answer.label === label, {
        description: `${node.id} is ${label}`,
      });
    }
    const matchAt = thresholds.match ?? 0.8;
    const missAt = thresholds.miss ?? matchAt;
    if (missAt > matchAt) throw new Error("Classify threshold `miss` must be <= `match`");
    return node.whereResult(
      (answer) => {
        const probability = answer.probabilities[label] ?? 0;
        const others = labels.filter((candidate) => candidate !== label);
        const runnerUp = Math.max(0, ...others.map((candidate) => answer.probabilities[candidate] ?? 0));
        const margin = probability - runnerUp;
        if (probability >= matchAt && (thresholds.margin === undefined || margin >= thresholds.margin)) {
          return matched(`${label}=${probability.toFixed(3)}`);
        }
        if (probability <= missAt) return missed(`${label}=${probability.toFixed(3)}`);
        return uncertain(`${label}=${probability.toFixed(3)} is between ${missAt} and ${matchAt}`);
      },
      { description: `${node.id} is ${label} with confidence thresholds` },
    );
  };

  return Object.assign(node, {
    labels,
    is,
    oneOf: (...wanted: ReadonlyArray<Label>) =>
      node.where((answer) => wanted.includes(answer.label), {
        description: `${node.id} in [${wanted.join(", ")}]`,
      }),
    not: (label: Label) => node.where((answer) => answer.label !== label, { description: `${node.id} is not ${label}` }),
    margin: (label: Label, over: Label, by: number) =>
      node.where((answer) => (answer.probabilities[label] ?? 0) - (answer.probabilities[over] ?? 0) >= by, {
        description: `${node.id}: ${label} leads ${over} by ${by}`,
      }),
  });
};

/** Create an unscoped semantic classification. */
export const classify = <Label extends string>(options: {
  readonly id?: string;
  readonly instructions: string;
  readonly criteria: { readonly [L in Label]: string };
}): ClassifyDecision<any, Label> => classifyFor<any, Label, undefined>(options, undefined);

export interface ProbabilityBand {
  /** Value at or above which the pattern matches. */
  readonly match: number;
  /** Value at or below which the pattern misses. Between values is uncertain. */
  readonly miss: number;
}

export interface ProbabilityDecision<Input = any, S extends Schema.Constraint | undefined = undefined>
  extends DecisionNode<Input, Decision.Probability, S> {
  readonly above: (threshold: number, options?: { readonly missBelow?: number }) => Pattern<Input>;
  readonly atLeast: (threshold: number, options?: { readonly missBelow?: number }) => Pattern<Input>;
  readonly below: (threshold: number, options?: { readonly missAbove?: number }) => Pattern<Input>;
  readonly atMost: (threshold: number, options?: { readonly missAbove?: number }) => Pattern<Input>;
  readonly between: (low: number, high: number) => Pattern<Input>;
  readonly band: (band: ProbabilityBand) => Pattern<Input>;
}

const probabilityFor = <Input, S extends Schema.Constraint | undefined>(
  options: {
    readonly id?: string;
    readonly instructions: string;
    readonly criteria?: { readonly false: string; readonly true: string } | undefined;
  },
  schema: S,
): ProbabilityDecision<Input, S> => {
  const { id, ...definition } = options;
  const node = makeDecisionNode<Input, Decision.Probability, S>(Decision.probability(definition), schema, id);
  const above = (threshold: number, inclusive: boolean, missBelow?: number) =>
    node.whereResult(
      (answer) => {
        const p = answer.probability;
        if (inclusive ? p >= threshold : p > threshold) return matched(`p=${p.toFixed(3)}`);
        const missAt = missBelow ?? threshold;
        if (p <= missAt) return missed(`p=${p.toFixed(3)}`);
        return uncertain(`p=${p.toFixed(3)} is between ${missAt} and ${threshold}`);
      },
      { description: `${node.id} ${inclusive ? ">=" : ">"} ${threshold}` },
    );
  const below = (threshold: number, inclusive: boolean, missAbove?: number) =>
    node.whereResult(
      (answer) => {
        const p = answer.probability;
        if (inclusive ? p <= threshold : p < threshold) return matched(`p=${p.toFixed(3)}`);
        const missAt = missAbove ?? threshold;
        if (p >= missAt) return missed(`p=${p.toFixed(3)}`);
        return uncertain(`p=${p.toFixed(3)} is between ${threshold} and ${missAt}`);
      },
      { description: `${node.id} ${inclusive ? "<=" : "<"} ${threshold}` },
    );

  return Object.assign(node, {
    above: (threshold: number, more: { readonly missBelow?: number } = {}) => above(threshold, false, more.missBelow),
    atLeast: (threshold: number, more: { readonly missBelow?: number } = {}) => above(threshold, true, more.missBelow),
    below: (threshold: number, more: { readonly missAbove?: number } = {}) => below(threshold, false, more.missAbove),
    atMost: (threshold: number, more: { readonly missAbove?: number } = {}) => below(threshold, true, more.missAbove),
    between: (low: number, high: number) => node.where((answer) => answer.probability >= low && answer.probability <= high, {
      description: `${node.id} between ${low} and ${high}`,
    }),
    band: ({ match: matchAt, miss: missAt }: ProbabilityBand) => {
      if (missAt > matchAt) throw new Error("Probability band `miss` must be <= `match`");
      return above(matchAt, true, missAt);
    },
  });
};

/** Create an unscoped semantic probability estimate. */
export const probability = (options: {
  readonly id?: string;
  readonly instructions: string;
  readonly criteria?: { readonly false: string; readonly true: string } | undefined;
}): ProbabilityDecision<any> => probabilityFor<any, undefined>(options, undefined);

export interface RateDecision<Input, Level extends string, S extends Schema.Constraint | undefined = undefined>
  extends DecisionNode<Input, Decision.Rate<Level>, S> {
  readonly levels: ReadonlyArray<Level>;
  readonly is: (level: Level) => Pattern<Input>;
  readonly atLeast: (level: Level) => Pattern<Input>;
  readonly atMost: (level: Level) => Pattern<Input>;
  readonly between: (low: Level, high: Level) => Pattern<Input>;
}

const rateFor = <Input, const Level extends string, S extends Schema.Constraint | undefined>(
  options: {
    readonly id?: string;
    readonly instructions: string;
    readonly criteria: ReadonlyArray<Level>;
  },
  schema: S,
): RateDecision<Input, Level, S> => {
  const { id, ...definition } = options;
  const node = makeDecisionNode<Input, Decision.Rate<Level>, S>(Decision.rate(definition), schema, id);
  const indexOf = (level: Level): number => options.criteria.indexOf(level);
  return Object.assign(node, {
    levels: options.criteria,
    is: (level: Level) => node.where((answer) => answer.label === level, { description: `${node.id} is ${level}` }),
    atLeast: (level: Level) => node.where((answer) => answer.rating >= indexOf(level), { description: `${node.id} >= ${level}` }),
    atMost: (level: Level) => node.where((answer) => answer.rating <= indexOf(level), { description: `${node.id} <= ${level}` }),
    between: (low: Level, high: Level) => node.where(
      (answer) => answer.rating >= indexOf(low) && answer.rating <= indexOf(high),
      { description: `${node.id} between ${low} and ${high}` },
    ),
  });
};

/** Create an unscoped semantic ordered rating. */
export const rate = <const Level extends string>(options: {
  readonly id?: string;
  readonly instructions: string;
  readonly criteria: ReadonlyArray<Level>;
}): RateDecision<any, Level> => rateFor<any, Level, undefined>(options, undefined);

// -------------------------------------------------------------------------------------------------
// Patterns
// -------------------------------------------------------------------------------------------------

export type PatternAst =
  | { readonly _tag: "Semantic"; readonly id: string; readonly decisionId: string; readonly description?: string }
  | { readonly _tag: "Deterministic"; readonly id: string; readonly description?: string }
  | { readonly _tag: "And"; readonly patterns: ReadonlyArray<PatternAst> }
  | { readonly _tag: "Or"; readonly patterns: ReadonlyArray<PatternAst> }
  | { readonly _tag: "Not"; readonly pattern: PatternAst };

type Preview =
  | { readonly resolved: PatternResult; readonly decisions: ReadonlyArray<AnyDecisionNode> }
  | { readonly resolved?: undefined; readonly decisions: ReadonlyArray<AnyDecisionNode> };

export interface Pattern<Input = any> {
  readonly [PatternTypeId]: typeof PatternTypeId;
  readonly id: string;
  readonly decisions: ReadonlyArray<AnyDecisionNode>;
  readonly ast: PatternAst;
  readonly evaluate: (input: Input, answers: AnswerLookup) => PatternResult;
  readonly preview: (input: Input) => Preview;
}

const makePattern = <Input>(options: {
  readonly id: string;
  readonly decisions: ReadonlyArray<AnyDecisionNode>;
  readonly ast: PatternAst;
  readonly evaluate: (input: Input, answers: AnswerLookup) => PatternResult;
  readonly preview: (input: Input) => Preview;
}): Pattern<Input> => ({ [PatternTypeId]: PatternTypeId, ...options });

const semanticLeaf = <Input>(
  node: AnyDecisionNode,
  evaluateAnswer: (answer: unknown) => PatternResult,
  options: { readonly id?: string; readonly description?: string } = {},
): Pattern<Input> => {
  const id = options.id ?? `p_${hash({ node: node.id, description: options.description ?? "custom" })}`;
  return makePattern({
    id,
    decisions: [node],
    ast: { _tag: "Semantic", id, decisionId: node.id, description: options.description },
    evaluate: (_input, answers) => evaluateAnswer(answers[node.id]),
    preview: () => ({ decisions: [node] }),
  });
};

/** A deterministic predicate that composes with semantic patterns and costs no model call. */
export const deterministic = <Input>(
  predicate: (input: Input) => boolean,
  options: { readonly id?: string; readonly description?: string } = {},
): Pattern<Input> => {
  const id = options.id ?? `guard_${hash(options.description ?? String(predicate))}`;
  return makePattern({
    id,
    decisions: [],
    ast: { _tag: "Deterministic", id, description: options.description },
    evaluate: (input) => (predicate(input) ? matched() : missed()),
    preview: (input) => ({ resolved: predicate(input) ? matched() : missed(), decisions: [] }),
  });
};

/** Aliases that read naturally next to Effect Predicate / Match terminology. */
export const predicate = deterministic;
export const structural = deterministic;

/** Build a semantic refinement directly from a decision node. */
export const refine = <Input, D extends AnyDecision, S extends Schema.Constraint | undefined>(
  node: DecisionNode<Input, D, S>,
  fn: (answer: Answer<D>) => boolean,
): Pattern<Input> => node.where(fn);

/** Build a tri-state semantic refinement directly from a decision node. */
export const refineResult = <Input, D extends AnyDecision, S extends Schema.Constraint | undefined>(
  node: DecisionNode<Input, D, S>,
  fn: (answer: Answer<D>) => PatternResult,
): Pattern<Input> => node.whereResult(fn);

const distinctDecisions = (patterns: ReadonlyArray<Pattern<any>>): ReadonlyArray<AnyDecisionNode> => {
  const byId = new Map<string, AnyDecisionNode>();
  for (const pattern of patterns) {
    for (const node of pattern.decisions) {
      const previous = byId.get(node.id);
      if (previous !== undefined && previous.fingerprint !== node.fingerprint) {
        throw new Error(`Decision id collision for "${node.id}": definitions differ`);
      }
      byId.set(node.id, previous ?? node);
    }
  }
  return [...byId.values()];
};

const andResult = (results: ReadonlyArray<PatternResult>): PatternResult => {
  const miss = results.find((result) => result._tag === "Miss");
  if (miss !== undefined) return miss;
  const maybe = results.find((result) => result._tag === "Uncertain");
  return maybe ?? matched();
};

const orResult = (results: ReadonlyArray<PatternResult>): PatternResult => {
  const hit = results.find((result) => result._tag === "Match");
  if (hit !== undefined) return hit;
  const maybe = results.find((result) => result._tag === "Uncertain");
  return maybe ?? missed();
};

/** Kleene-style three-valued AND: Miss dominates; otherwise Uncertain dominates. */
export const and = <Input>(...patterns: ReadonlyArray<Pattern<Input>>): Pattern<Input> =>
  makePattern({
    id: `and_${hash(patterns.map((pattern) => pattern.id))}`,
    decisions: distinctDecisions(patterns),
    ast: { _tag: "And", patterns: patterns.map((pattern) => pattern.ast) },
    evaluate: (input, answers) => andResult(patterns.map((pattern) => pattern.evaluate(input, answers))),
    preview: (input) => {
      const parts = patterns.map((pattern) => pattern.preview(input));
      const miss = parts.find((part) => part.resolved?._tag === "Miss");
      if (miss?.resolved !== undefined) return { resolved: miss.resolved, decisions: [] };
      if (parts.every((part) => part.resolved?._tag === "Match")) return { resolved: matched(), decisions: [] };
      return { decisions: distinctNodes(parts.flatMap((part) => part.decisions)) };
    },
  });

/** Kleene-style three-valued OR: Match dominates; otherwise Uncertain dominates. */
export const or = <Input>(...patterns: ReadonlyArray<Pattern<Input>>): Pattern<Input> =>
  makePattern({
    id: `or_${hash(patterns.map((pattern) => pattern.id))}`,
    decisions: distinctDecisions(patterns),
    ast: { _tag: "Or", patterns: patterns.map((pattern) => pattern.ast) },
    evaluate: (input, answers) => orResult(patterns.map((pattern) => pattern.evaluate(input, answers))),
    preview: (input) => {
      const parts = patterns.map((pattern) => pattern.preview(input));
      const hit = parts.find((part) => part.resolved?._tag === "Match");
      if (hit?.resolved !== undefined) return { resolved: hit.resolved, decisions: [] };
      if (parts.every((part) => part.resolved?._tag === "Miss")) return { resolved: missed(), decisions: [] };
      return { decisions: distinctNodes(parts.flatMap((part) => part.decisions)) };
    },
  });

/** Negation preserves Uncertain and swaps Match / Miss. */
export const not = <Input>(pattern: Pattern<Input>): Pattern<Input> =>
  makePattern({
    id: `not_${pattern.id}`,
    decisions: pattern.decisions,
    ast: { _tag: "Not", pattern: pattern.ast },
    evaluate: (input, answers) => {
      const result = pattern.evaluate(input, answers);
      return result._tag === "Match" ? missed(result.reason) : result._tag === "Miss" ? matched(result.reason) : result;
    },
    preview: (input) => {
      const inner = pattern.preview(input);
      if (inner.resolved === undefined) return inner;
      return {
        resolved: inner.resolved._tag === "Match" ? missed(inner.resolved.reason) : inner.resolved._tag === "Miss" ? matched(inner.resolved.reason) : inner.resolved,
        decisions: [],
      };
    },
  });

/** Partial evaluation used to avoid semantic work when deterministic structure already decides the case. */
const preview = <Input>(pattern: Pattern<Input>, input: Input): Preview => pattern.preview(input);

const distinctNodes = (nodes: ReadonlyArray<AnyDecisionNode>): ReadonlyArray<AnyDecisionNode> => {
  const byId = new Map<string, AnyDecisionNode>();
  for (const node of nodes) {
    const previous = byId.get(node.id);
    if (previous !== undefined && previous.fingerprint !== node.fingerprint) {
      throw new Error(`Decision id collision for "${node.id}"`);
    }
    byId.set(node.id, previous ?? node);
  }
  return [...byId.values()];
};

// -------------------------------------------------------------------------------------------------
// Input-aware scopes
// -------------------------------------------------------------------------------------------------

export interface Scope<S extends Schema.Constraint> {
  readonly schema: S;
  readonly classify: <Label extends string>(options: {
    readonly id?: string;
    readonly instructions: string;
    readonly criteria: { readonly [L in Label]: string };
  }) => ClassifyDecision<S["Type"], Label, S>;
  readonly probability: (options: {
    readonly id?: string;
    readonly instructions: string;
    readonly criteria?: { readonly false: string; readonly true: string } | undefined;
  }) => ProbabilityDecision<S["Type"], S>;
  readonly rate: <const Level extends string>(options: {
    readonly id?: string;
    readonly instructions: string;
    readonly criteria: ReadonlyArray<Level>;
  }) => RateDecision<S["Type"], Level, S>;
}

/** Bind semantic decision constructors to one input schema. */
export const on = <S extends Schema.Constraint>(schema: S): Scope<S> => ({
  schema,
  classify: (options) => classifyFor<S["Type"], any, S>(options as any, schema),
  probability: (options) => probabilityFor<S["Type"], S>(options, schema),
  rate: (options) => rateFor<S["Type"], any, S>(options as any, schema),
});

export const scope = on;

// -------------------------------------------------------------------------------------------------
// Matcher, plan & tracing
// -------------------------------------------------------------------------------------------------

export type MatcherFlavor = "type" | "value";

interface Case {
  readonly id: string;
  readonly pattern: Pattern<any>;
  readonly handler: (input: any) => any;
}

export interface Matcher<
  Input,
  InputSchema extends Schema.Constraint,
  Out = never,
  Err = never,
  Req = never,
  Flavor extends MatcherFlavor = "type",
> extends Pipeable {
  readonly _tag: "Matcher";
  readonly flavor: Flavor;
  readonly schema: InputSchema;
  readonly provided?: Input;
  readonly cases: ReadonlyArray<Case>;
  readonly uncertainHandler?: ((input: Input, context: UncertainContext) => any) | undefined;
  readonly _types?: {
    readonly input: Input;
    readonly out: Out;
    readonly error: Err;
    readonly requirements: Req;
    readonly flavor: Flavor;
  };
}

type AnyMatcher = Matcher<any, any, any, any, any, MatcherFlavor>;

export interface UncertainContext {
  readonly caseId: string;
  readonly result: PatternResult;
}

const makeMatcher = <S extends Schema.Constraint, F extends MatcherFlavor>(
  schema: S,
  flavor: F,
  provided?: S["Type"],
): Matcher<S["Type"], S, never, never, never, F> => {
  const self = {
    _tag: "Matcher" as const,
    flavor,
    schema,
    ...(flavor === "value" ? { provided } : undefined),
    cases: [] as ReadonlyArray<Case>,
    pipe(...fns: ReadonlyArray<(value: any) => any>) {
      return pipe(self, fns);
    },
  };
  return self as any;
};

const cloneMatcher = (self: AnyMatcher, patch: Partial<AnyMatcher>): AnyMatcher => {
  const next: any = { ...self, ...patch };
  next.pipe = (...fns: ReadonlyArray<(value: any) => any>) => pipe(next, fns);
  return next;
};

/** Start a reusable semantic matcher, analogous to Effect Match.type. */
export const type = <S extends Schema.Constraint>(schema: S): Matcher<S["Type"], S, never, never, never, "type"> =>
  makeMatcher(schema, "type");

/** Start matching one value immediately, analogous to Effect Match.value. */
export const value = <S extends Schema.Constraint>(
  schema: S,
  input: S["Type"],
): Matcher<S["Type"], S, never, never, never, "value"> => makeMatcher(schema, "value", input);

/** Add an ordered semantic / deterministic case. */
export const when = <PatternInput, H extends Handler<PatternInput, any>>(
  pattern: Pattern<PatternInput>,
  handler: H,
  options: { readonly id?: string } = {},
) =>
  <I extends PatternInput, S extends Schema.Constraint, O, E, R, F extends MatcherFlavor>(
    self: Matcher<I, S, O, E, R, F>,
  ): Matcher<
    I,
    S,
    O | EffectSuccess<ReturnType<H>>,
    E | EffectError<ReturnType<H>>,
    R | EffectRequirements<ReturnType<H>>,
    F
  > => {
    const id = options.id ?? `case_${self.cases.length}`;
    return cloneMatcher(self, { cases: [...self.cases, { id, pattern, handler }] }) as any;
  };

/** Handle uncertainty from the first higher-priority case that cannot be resolved confidently. */
export const onUncertain = <I, H extends (input: I, context: UncertainContext) => any>(handler: H) =>
  <S extends Schema.Constraint, O, E, R, F extends MatcherFlavor>(
    self: Matcher<I, S, O, E, R, F>,
  ): Matcher<
    I,
    S,
    O | EffectSuccess<ReturnType<H>>,
    E | EffectError<ReturnType<H>>,
    R | EffectRequirements<ReturnType<H>>,
    F
  > => cloneMatcher(self, { uncertainHandler: handler }) as any;

export interface DecisionInspection {
  readonly id: string;
  readonly fingerprint: string;
  readonly kind: AnyDecision["_tag"];
  readonly instructions: string;
  readonly criteria?: unknown;
}

export interface CaseInspection {
  readonly id: string;
  readonly pattern: PatternAst;
}

export interface CompiledPlan {
  readonly version: 1;
  readonly fingerprint: string;
  readonly decisions: ReadonlyArray<DecisionInspection>;
  readonly cases: ReadonlyArray<CaseInspection>;
  readonly hasUncertainHandler: boolean;
}

/** Compile a matcher into an inspectable semantic execution plan. */
export const compile = (self: AnyMatcher): CompiledPlan => {
  const nodes = distinctDecisions(self.cases.map((item) => item.pattern));
  const decisions = nodes.map((node): DecisionInspection => ({
    id: node.id,
    fingerprint: node.fingerprint,
    kind: node.decision._tag,
    instructions: node.decision.instructions,
    ...(node.decision._tag === "Classify" || node.decision._tag === "Rate" || node.decision.criteria !== undefined
      ? { criteria: node.decision.criteria }
      : undefined),
  }));
  const cases = self.cases.map((item): CaseInspection => ({ id: item.id, pattern: item.pattern.ast }));
  const fingerprint = `plan_${hash({ decisions, cases })}`;
  return { version: 1, fingerprint, decisions, cases, hasUncertainHandler: self.uncertainHandler !== undefined };
};

/** Return the serializable representation of a compiled semantic plan. */
export const inspect = (value: AnyMatcher | CompiledPlan): CompiledPlan =>
  ("version" in value ? value : compile(value as AnyMatcher));

export interface TraceDecision {
  readonly fingerprint: string;
  readonly answer: unknown;
}

export interface CaseTrace {
  readonly id: string;
  readonly status: PatternStatus;
  readonly reason?: string | undefined;
}

export interface Trace {
  readonly version: 1;
  readonly planFingerprint: string;
  readonly decisions: Readonly<Record<string, TraceDecision>>;
  readonly cases: ReadonlyArray<CaseTrace>;
  readonly selected:
    | { readonly _tag: "Case"; readonly id: string }
    | { readonly _tag: "Fallback" }
    | { readonly _tag: "Uncertain"; readonly id: string };
}

interface RuntimeObservation {
  readonly answers: AnswerLookup;
  readonly traceDecisions: Readonly<Record<string, TraceDecision>>;
}

const buildDefinition = <S extends Schema.Constraint>(schema: S, nodes: ReadonlyArray<AnyDecisionNode>) => {
  const decisions: Record<string, AnyDecision> = Object.create(null);
  for (const node of nodes) decisions[node.id] = node.decision;
  return Decision.make({ input: schema, decisions });
};

const nodesNeededForInput = <I>(cases: ReadonlyArray<Case>, input: I): ReadonlyArray<AnyDecisionNode> => {
  const nodes: Array<AnyDecisionNode> = [];
  for (const item of cases) {
    const attempt = preview(item.pattern, input);
    if (attempt.resolved?._tag === "Match") break;
    if (attempt.resolved?._tag === "Miss") continue;
    nodes.push(...attempt.decisions);
  }
  return distinctNodes(nodes);
};

const observe = <I, S extends Schema.Constraint>(
  schema: S,
  nodes: ReadonlyArray<AnyDecisionNode>,
  input: I,
): Effect.Effect<RuntimeObservation, AiError.AiError, DecisionModel.DecisionModel | S["EncodingServices"]> => {
  if (nodes.length === 0) return Effect.succeed({ answers: {}, traceDecisions: {} }) as any;
  const definition = buildDefinition(schema, nodes);
  return Effect.map(DecisionModel.decide(definition, { input: input as S["Type"] }), ({ answers }) => {
    const traceDecisions: Record<string, TraceDecision> = Object.create(null);
    for (const node of nodes) traceDecisions[node.id] = { fingerprint: node.fingerprint, answer: answers[node.id] };
    return { answers, traceDecisions };
  }) as any;
};

const observeFromTrace = (
  plan: CompiledPlan,
  nodes: ReadonlyArray<AnyDecisionNode>,
  trace: Trace,
): RuntimeObservation | ReplayMismatchError => {
  if (trace.planFingerprint !== plan.fingerprint) {
    return new ReplayMismatchError(
      `Trace was recorded for ${trace.planFingerprint}, but current plan is ${plan.fingerprint}`,
    );
  }
  const answers: Record<string, unknown> = Object.create(null);
  const traceDecisions: Record<string, TraceDecision> = Object.create(null);
  for (const node of nodes) {
    const record = trace.decisions[node.id];
    if (record === undefined) return new ReplayMismatchError(`Trace is missing decision "${node.id}"`);
    if (record.fingerprint !== node.fingerprint) {
      return new ReplayMismatchError(`Decision "${node.id}" changed since the trace was recorded`);
    }
    answers[node.id] = record.answer;
    traceDecisions[node.id] = record;
  }
  return { answers, traceDecisions };
};

const dispatch = <I, F>(
  self: AnyMatcher,
  input: I,
  answers: AnswerLookup,
  fallback: Handler<I, F>,
  traceDecisions: Readonly<Record<string, TraceDecision>>,
  plan: CompiledPlan,
): Effect.Effect<any, any, any> => {
  const caseTrace: Array<CaseTrace> = [];
  for (const item of self.cases) {
    const quick = preview(item.pattern, input);
    const result = quick.resolved ?? item.pattern.evaluate(input, answers);
    caseTrace.push({ id: item.id, status: result._tag, ...(result.reason === undefined ? undefined : { reason: result.reason }) });
    if (result._tag === "Match") {
      return Effect.map(asEffect(item.handler(input)), (value) => ({
        value,
        trace: {
          version: 1,
          planFingerprint: plan.fingerprint,
          decisions: traceDecisions,
          cases: caseTrace,
          selected: { _tag: "Case", id: item.id },
        } satisfies Trace,
      }));
    }
    if (result._tag === "Uncertain") {
      if (self.uncertainHandler !== undefined) {
        return Effect.map(asEffect(self.uncertainHandler(input, { caseId: item.id, result })), (value) => ({
          value,
          trace: {
            version: 1,
            planFingerprint: plan.fingerprint,
            decisions: traceDecisions,
            cases: caseTrace,
            selected: { _tag: "Uncertain", id: item.id },
          } satisfies Trace,
        }));
      }
      return Effect.fail(new UncertainMatchError(item.id, result.reason));
    }
  }
  return Effect.map(asEffect(fallback(input)), (value) => ({
    value,
    trace: {
      version: 1,
      planFingerprint: plan.fingerprint,
      decisions: traceDecisions,
      cases: caseTrace,
      selected: { _tag: "Fallback" },
    } satisfies Trace,
  }));
};

const runWithTraceInternal = <I, S extends Schema.Constraint, F>(
  self: Matcher<I, S, any, any, any, MatcherFlavor>,
  input: I,
  fallback: Handler<I, F>,
  plan: CompiledPlan = compile(self),
): Effect.Effect<any, any, any> => {
  const nodes = nodesNeededForInput(self.cases, input);
  return Effect.flatMap(observe(self.schema, nodes, input), ({ answers, traceDecisions }) =>
    dispatch(self, input, answers, fallback, traceDecisions, plan),
  );
};

const replayInternal = <I, F>(
  self: AnyMatcher,
  input: I,
  fallback: Handler<I, F>,
  trace: Trace,
  plan: CompiledPlan = compile(self),
): Effect.Effect<any, any, any> => {
  const nodes = nodesNeededForInput(self.cases, input);
  const observed = observeFromTrace(plan, nodes, trace);
  if (observed instanceof ReplayMismatchError) return Effect.fail(observed);
  return dispatch(self, input, observed.answers, fallback, observed.traceDecisions, plan);
};

export interface Program<
  Input,
  Output,
  Error,
  Requirements,
  InputSchema extends Schema.Constraint = Schema.Constraint,
> {
  readonly [ProgramTypeId]: typeof ProgramTypeId;
  (input: Input): Effect.Effect<
    Output,
    Error | AiError.AiError | UncertainMatchError,
    Requirements | DecisionModel.DecisionModel | InputSchema["EncodingServices"]
  >;
  readonly plan: CompiledPlan;
  readonly runWithTrace: (
    input: Input,
  ) => Effect.Effect<
    { readonly value: Output; readonly trace: Trace },
    Error | AiError.AiError | UncertainMatchError,
    Requirements | DecisionModel.DecisionModel | InputSchema["EncodingServices"]
  >;
  readonly replay: (
    input: Input,
    trace: Trace,
  ) => Effect.Effect<Output, Error | DiscernError, Requirements>;
}

const makeProgram = <I, S extends Schema.Constraint, O, E, R, F>(
  self: Matcher<I, S, O, E, R, MatcherFlavor>,
  fallback: Handler<I, F>,
): Program<I, O | EffectSuccess<F>, E | EffectError<F>, R | EffectRequirements<F>, S> => {
  const plan = compile(self);
  const runWithTrace = (input: I) => runWithTraceInternal(self, input, fallback, plan) as any;
  const fn = ((input: I) => Effect.map(runWithTrace(input) as any, (result: any) => result.value)) as any;
  return Object.assign(fn, {
    [ProgramTypeId]: ProgramTypeId,
    plan,
    runWithTrace,
    replay: (input: I, trace: Trace) =>
      Effect.map(replayInternal(self, input, fallback, trace, plan) as any, (result: any) => result.value),
  });
};

export type FinishedMatcher<
  I,
  S extends Schema.Constraint,
  O,
  E,
  R,
  F,
  Flavor extends MatcherFlavor,
> = Flavor extends "type"
  ? Program<I, O | EffectSuccess<F>, E | EffectError<F>, R | EffectRequirements<F>, S>
  : Effect.Effect<
      O | EffectSuccess<F>,
      E | EffectError<F> | AiError.AiError | UncertainMatchError,
      R | EffectRequirements<F> | DecisionModel.DecisionModel | S["EncodingServices"]
    >;

/** Complete the matcher with a fallback. For reusable matchers this returns a callable Program. */
export const orElse = <F extends Handler<any, any>>(fallback: F) =>
  <I, S extends Schema.Constraint, O, E, R, Flavor extends MatcherFlavor>(
    self: Matcher<I, S, O, E, R, Flavor>,
  ): FinishedMatcher<I, S, O, E, R, ReturnType<F>, Flavor> => {
    const program = makeProgram(self, fallback);
    return (self.flavor === "type" ? program : program(self.provided as I)) as any;
  };

export const otherwise = orElse;

/** Execute an unfinished matcher explicitly while recording a trace. */
export const runWithTrace = <I, S extends Schema.Constraint, O, E, R, F>(
  self: Matcher<I, S, O, E, R, MatcherFlavor>,
  input: I,
  fallback: Handler<I, F>,
) => runWithTraceInternal(self, input, fallback) as Effect.Effect<any, any, any>;

// -------------------------------------------------------------------------------------------------
// Exhaustive classification matching
// -------------------------------------------------------------------------------------------------

export interface ClassificationMatcher<
  Input,
  S extends Schema.Constraint,
  Label extends string,
  Remaining extends Label,
  O = never,
  E = never,
  R = never,
> extends Pipeable {
  readonly _tag: "ClassificationMatcher";
  readonly decision: ClassifyDecision<Input, Label, S>;
  readonly matcher: Matcher<Input, S, O, E, R, "type">;
  readonly _remaining?: Remaining;
}

const makeClassificationMatcher = <I, S extends Schema.Constraint, L extends string, Remaining extends L, O, E, R>(
  node: ClassifyDecision<I, L, S>,
  matcher: Matcher<I, S, O, E, R, "type">,
): ClassificationMatcher<I, S, L, Remaining, O, E, R> => {
  const self: any = {
    _tag: "ClassificationMatcher",
    decision: node,
    matcher,
    pipe(...fns: ReadonlyArray<(value: any) => any>) {
      return pipe(self, fns);
    },
  };
  return self;
};

/** Match exhaustively over the labels of one schema-scoped classification decision. */
export const match = <I, S extends Schema.Constraint, L extends string>(
  node: ClassifyDecision<I, L, S>,
): ClassificationMatcher<I, S, L, L> => {
  if (node.schema === undefined) throw new Error("Discern.match requires a schema-scoped decision created with Discern.on(schema)");
  return makeClassificationMatcher<I, S, L, L, never, never, never>(node, type(node.schema as S) as any);
};

export const caseOf = <L extends string, H extends Handler<any, any>>(label: L, handler: H) =>
  <I, S extends Schema.Constraint, All extends string, Remaining extends All, O, E, R>(
    self: L extends Remaining ? ClassificationMatcher<I, S, All, Remaining, O, E, R> : never,
  ): ClassificationMatcher<
    I,
    S,
    All,
    Exclude<Remaining, L & All>,
    O | EffectSuccess<ReturnType<H>>,
    E | EffectError<ReturnType<H>>,
    R | EffectRequirements<ReturnType<H>>
  > => {
    const matcher = when(self.decision.is(label as unknown as All), handler as any, { id: `case_${String(label)}` })(self.matcher as any);
    return makeClassificationMatcher(self.decision, matcher as any) as any;
  };

export { caseOf as case };

/** Finish only when every classification label has a handler. */
export const exhaustive = <I, S extends Schema.Constraint, L extends string, O, E, R>(
  self: ClassificationMatcher<I, S, L, never, O, E, R>,
): Program<I, O, E | ExhaustiveMatchError, R, S> =>
  orElse(() => Effect.fail(new ExhaustiveMatchError()))(self.matcher) as any;

// -------------------------------------------------------------------------------------------------
// Cache
// -------------------------------------------------------------------------------------------------

export interface TraceCache {
  readonly get: (key: string) => Trace | undefined;
  readonly set: (key: string, trace: Trace) => void;
  readonly delete?: ((key: string) => void) | undefined;
  readonly clear?: (() => void) | undefined;
}

export const memoryCache = (): TraceCache => {
  const values = new Map<string, Trace>();
  return {
    get: (key) => values.get(key),
    set: (key, trace) => void values.set(key, trace),
    delete: (key) => void values.delete(key),
    clear: () => values.clear(),
  };
};

/**
 * Cache semantic observations, not workflow results. A hit replays the trace,
 * so handlers and their effects still execute normally.
 */
export const cached = <I, A, E, R, S extends Schema.Constraint>(
  program: Program<I, A, E, R, S>,
  options: { readonly cache: TraceCache; readonly key: (input: I) => string },
): Program<I, A, E, R, S> => {
  const cacheKey = (input: I) => `${program.plan.fingerprint}:${options.key(input)}`;
  const runWithTrace = (input: I) => {
    const key = cacheKey(input);
    const existing = options.cache.get(key);
    if (existing !== undefined) {
      return Effect.map(program.replay(input, existing), (value) => ({ value, trace: existing })) as any;
    }
    return Effect.map(program.runWithTrace(input), ({ value, trace }) => {
      options.cache.set(key, trace);
      return { value, trace };
    }) as any;
  };
  const fn = ((input: I) => Effect.map(runWithTrace(input) as any, (result: any) => result.value)) as any;
  return Object.assign(fn, {
    [ProgramTypeId]: ProgramTypeId,
    plan: program.plan,
    runWithTrace,
    replay: program.replay,
  });
};

// -------------------------------------------------------------------------------------------------
// Evaluation & calibration
// -------------------------------------------------------------------------------------------------

export interface EvalExample<Input> {
  readonly input: Input;
  readonly expected: boolean;
  readonly id?: string | undefined;
}

export interface EvalRecord<Input> {
  readonly input: Input;
  readonly expected: boolean;
  readonly status: PatternStatus;
}

export interface EvalMetrics {
  readonly total: number;
  readonly decided: number;
  readonly uncertain: number;
  readonly coverage: number;
  readonly correct: number;
  readonly accuracy: number;
  readonly selectiveAccuracy: number;
  readonly truePositive: number;
  readonly falsePositive: number;
  readonly trueNegative: number;
  readonly falseNegative: number;
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
}

export interface EvalReport<Input> {
  readonly metrics: EvalMetrics;
  readonly records: ReadonlyArray<EvalRecord<Input>>;
}

const metricsOf = <Input>(records: ReadonlyArray<EvalRecord<Input>>): EvalMetrics => {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  let uncertainCount = 0;
  let correct = 0;
  for (const record of records) {
    if (record.status === "Uncertain") {
      uncertainCount += 1;
      continue;
    }
    const predicted = record.status === "Match";
    if (predicted === record.expected) correct += 1;
    if (predicted && record.expected) tp += 1;
    else if (predicted) fp += 1;
    else if (record.expected) fn += 1;
    else tn += 1;
  }
  const total = records.length;
  const decided = total - uncertainCount;
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return {
    total,
    decided,
    uncertain: uncertainCount,
    coverage: total === 0 ? 0 : decided / total,
    correct,
    accuracy: total === 0 ? 0 : correct / total,
    selectiveAccuracy: decided === 0 ? 0 : correct / decided,
    truePositive: tp,
    falsePositive: fp,
    trueNegative: tn,
    falseNegative: fn,
    precision,
    recall,
    f1,
  };
};

const observePattern = <I, S extends Schema.Constraint>(
  schema: S,
  pattern: Pattern<I>,
  input: I,
): Effect.Effect<{ readonly result: PatternResult; readonly answers: AnswerLookup }, AiError.AiError, DecisionModel.DecisionModel | S["EncodingServices"]> => {
  const attempt = preview(pattern, input);
  if (attempt.resolved !== undefined) return Effect.succeed({ result: attempt.resolved, answers: {} }) as any;
  return Effect.map(observe(schema, attempt.decisions, input), ({ answers }) => ({ result: pattern.evaluate(input, answers), answers })) as any;
};

export const Eval = {
  /** Evaluate one semantic pattern over labeled examples. */
  run: <I, S extends Schema.Constraint>(
    schema: S,
    pattern: Pattern<I>,
    examples: ReadonlyArray<EvalExample<I>>,
  ): Effect.Effect<EvalReport<I>, AiError.AiError, DecisionModel.DecisionModel | S["EncodingServices"]> =>
    Effect.map(
      effectAllSequential(examples, (example) =>
        Effect.map(observePattern(schema, pattern, example.input), ({ result }) => ({
          input: example.input,
          expected: example.expected,
          status: result._tag,
        } satisfies EvalRecord<I>)),
      ),
      (records) => ({ records, metrics: metricsOf(records) }),
    ) as any,

  /**
   * Sweep a parameterized pattern. All candidate patterns share one semantic
   * observation batch per example; thresholds are replayed deterministically.
   */
  sweep: <I, S extends Schema.Constraint, V>(options: {
    readonly schema: S;
    readonly values: ReadonlyArray<V>;
    readonly pattern: (value: V) => Pattern<I>;
    readonly examples: ReadonlyArray<EvalExample<I>>;
  }): Effect.Effect<ReadonlyArray<{ readonly value: V; readonly report: EvalReport<I> }>, AiError.AiError, DecisionModel.DecisionModel | S["EncodingServices"]> => {
    const patterns = options.values.map((value) => options.pattern(value));
    const allNodes = distinctDecisions(patterns);
    return Effect.map(
      effectAllSequential(options.examples, (example) =>
        Effect.map(observe(options.schema, allNodes, example.input), ({ answers }) => ({ example, answers })),
      ),
      (observed) =>
        options.values.map((value, index) => {
          const pattern = patterns[index]!;
          const records = observed.map(({ example, answers }) => ({
            input: example.input,
            expected: example.expected,
            status: pattern.evaluate(example.input, answers)._tag,
          } satisfies EvalRecord<I>));
          return { value, report: { records, metrics: metricsOf(records) } };
        }),
    ) as any;
  },

  /** Select the best sweep value by a metric, preferring higher coverage on ties. */
  calibrate: <I, S extends Schema.Constraint, V>(options: {
    readonly schema: S;
    readonly values: ReadonlyArray<V>;
    readonly pattern: (value: V) => Pattern<I>;
    readonly examples: ReadonlyArray<EvalExample<I>>;
    readonly metric?: "f1" | "accuracy" | "selectiveAccuracy";
  }) =>
    Effect.map(
      Eval.sweep(options),
      (results) => {
        const metric = options.metric ?? "f1";
        const sorted = [...results].sort((a, b) => {
          const delta = b.report.metrics[metric] - a.report.metrics[metric];
          return delta !== 0 ? delta : b.report.metrics.coverage - a.report.metrics.coverage;
        });
        return { best: sorted[0], results };
      },
    ),
};
