/**
 * DecisionModel middleware.
 *
 * Every semantic observation funnels through one `DecisionModel.decide` call,
 * so recording, replay, caching and budgeting are all *decorators of the
 * service* rather than features of the matcher. Building them here means they
 * apply to any Effect program that reaches a `DecisionModel` — including whole
 * trees of programs, and code that never mentions Discern.
 *
 * Interception happens above answer validation, so recorded answers are the
 * validated ones and replay never has to re-derive them.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as AiError from "effect/unstable/ai/AiError";
import * as Decision from "effect/unstable/ai/Decision";
import * as DecisionModel from "effect/unstable/ai/DecisionModel";
import { decisionFingerprint, observationAddress } from "./internal/hash.js";

// -------------------------------------------------------------------------------------------------
// Errors
// -------------------------------------------------------------------------------------------------

const discernError = (method: string, reason: AiError.AiErrorReason): AiError.AiError =>
  new AiError.AiError({ module: "Discern", method, reason });

/** True for the failure raised when a budget is exhausted. */
export const isBudgetExceeded = (error: unknown): error is AiError.AiError =>
  error instanceof AiError.AiError && error.module === "Discern" && error.method === "budgeted";

/** True for the failure raised when replay has no recorded answer for a decision. */
export const isReplayMiss = (error: unknown): error is AiError.AiError =>
  error instanceof AiError.AiError && error.module === "Discern" && error.method === "replaying";

// -------------------------------------------------------------------------------------------------
// Observations
// -------------------------------------------------------------------------------------------------

/**
 * The enclosing scope stack. It has a default, so it never appears in an
 * Effect's requirements.
 */
export const CurrentScope = Context.Reference<ReadonlyArray<string>>("discern/CurrentScope", {
  defaultValue: () => [],
});

/**
 * Name a region of a program so that observations recorded inside it are
 * attributed to it. Scopes nest, which is what turns a flat store into a tree.
 */
export const scope =
  (name: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.flatMap(CurrentScope.useSync((path) => path), (parent) =>
      Effect.provideService(effect, CurrentScope, [...parent, name]),
    );

/** One recorded semantic answer, with enough context to read it unaided. */
export interface Observation {
  /** The decision's name in the batch it was requested in. Diagnostic only. */
  readonly decisionId: string;
  /** Fingerprint of the decision definition. Diagnostic only; the address already pins it. */
  readonly fingerprint: string;
  readonly kind: Decision.Any["_tag"];
  /**
   * The scope stack this observation was most recently made under.
   *
   * An observation is content-addressed, so one entry covers every place the
   * same decision was asked about the same input. Re-recording moves it to the
   * newest scope. For a faithful per-run tree, record each run into its own
   * store.
   */
  readonly scope: ReadonlyArray<string>;
  /** A validated `Decision.Answer`. */
  readonly answer: unknown;
}

/** A serializable set of observations, keyed by content address. */
export interface Observations {
  readonly version: 2;
  readonly entries: Readonly<Record<string, Observation>>;
}

/** The minimum a store must do to back recording, caching or replay. */
export interface ObservationStore {
  readonly get: (address: string) => Observation | undefined;
  readonly set: (address: string, observation: Observation) => void;
}

/** An in-memory store that can also be snapshotted and reloaded. */
export interface MemoryStore extends ObservationStore {
  readonly snapshot: () => Observations;
  readonly load: (observations: Observations) => void;
  readonly size: () => number;
  readonly clear: () => void;
}

export const store = (initial?: Observations): MemoryStore => {
  const values = new Map<string, Observation>(initial ? Object.entries(initial.entries) : undefined);
  return {
    get: (address) => values.get(address),
    set: (address, observation) => void values.set(address, observation),
    snapshot: () => ({ version: 2, entries: Object.fromEntries(values) }),
    load: (observations) => {
      for (const [address, observation] of Object.entries(observations.entries)) {
        values.set(address, observation);
      }
    },
    size: () => values.size,
    clear: () => values.clear(),
  };
};

const asStore = (source: Observations | ObservationStore): ObservationStore =>
  "entries" in source ? store(source) : source;

// -------------------------------------------------------------------------------------------------
// Interceptors
// -------------------------------------------------------------------------------------------------

/**
 * A `DecisionModel` decorator. Interceptors are listed outermost-first, so in
 * `[recording, caching, budgeted]` the recorder observes every answer, the
 * cache is consulted next, and only genuine model calls draw from the budget.
 */
export type Interceptor = (inner: DecisionModel.DecisionModel) => DecisionModel.DecisionModel;

type AnyDefinition = Decision.Definition<any, Record<string, Decision.Any>>;
type Answers = Record<string, unknown>;

const emptyUsage = () => new DecisionModel.DecisionUsage({});

/** Encode the input exactly as `DecisionModel.decide` does, so addresses agree. */
const encodeState = (definition: AnyDefinition, input: unknown) =>
  Schema.encodeEffect(Schema.toCodecJson(definition.input))(input).pipe(
    Effect.mapError((error) =>
      discernError("encode", new AiError.InvalidUserInputError({ description: error.message })),
    ),
  );

interface Split {
  readonly hits: Answers;
  readonly missing: Record<string, Decision.Any>;
  readonly addresses: Record<string, string>;
}

const split = (definition: AnyDefinition, state: unknown, lookup: ObservationStore | undefined): Split => {
  const hits: Answers = {};
  const missing: Record<string, Decision.Any> = {};
  const addresses: Record<string, string> = {};
  for (const [id, decision] of Object.entries(definition.decisions)) {
    const address = observationAddress(decision, state);
    addresses[id] = address;
    const found = lookup?.get(address);
    if (found === undefined) missing[id] = decision;
    else hits[id] = found.answer;
  }
  return { hits, missing, addresses };
};

const record = (
  into: ObservationStore,
  decisions: Record<string, Decision.Any>,
  addresses: Record<string, string>,
  answers: Answers,
  scopePath: ReadonlyArray<string>,
): void => {
  for (const [id, decision] of Object.entries(decisions)) {
    const answer = answers[id];
    if (answer === undefined) continue;
    into.set(addresses[id]!, {
      decisionId: id,
      fingerprint: decisionFingerprint(decision),
      kind: decision._tag,
      scope: scopePath,
      answer,
    });
  }
};

/** Build a `DecisionModel` whose `decide` is supplied as an untyped function. */
const fromDecide = (
  decide: (definition: AnyDefinition, input: unknown) => Effect.Effect<any, AiError.AiError, any>,
): DecisionModel.DecisionModel =>
  DecisionModel.DecisionModel.of({
    [DecisionModel.TypeId]: DecisionModel.TypeId,
    decide: ((definition: AnyDefinition, options: { input: unknown }) =>
      decide(definition, options.input)) as DecisionModel.DecisionModel["decide"],
  });

/** Record every answer the model gives, keyed by content address. */
export const recording =
  (into: ObservationStore): Interceptor =>
  (inner) =>
    fromDecide((definition, input) =>
      Effect.flatMap(encodeState(definition, input), (state) => {
        const { addresses } = split(definition, state, undefined);
        return Effect.flatMap(CurrentScope.useSync((path) => path), (scopePath) =>
          Effect.map(inner.decide(definition as never, { input } as never), (response) => {
            record(into, definition.decisions, addresses, response.answers as Answers, scopePath);
            return response;
          }),
        );
      }),
    );

/**
 * Answer from recorded observations instead of calling the model.
 *
 * Because the address covers the decision definition *and* the input, a changed
 * decision simply has no recorded answer — there is no separate fingerprint
 * check to keep in sync.
 */
export const replaying = (
  source: Observations | ObservationStore,
  options: { readonly onMissing?: "fail" | "ask" } = {},
): Interceptor => {
  const lookup = asStore(source);
  const onMissing = options.onMissing ?? "fail";
  return (inner) =>
    fromDecide((definition, input) =>
      Effect.flatMap(encodeState(definition, input), (state) => {
        const { hits, missing } = split(definition, state, lookup);
        const missingIds = Object.keys(missing);
        if (missingIds.length === 0) return Effect.succeed({ answers: hits, usage: emptyUsage() });
        if (onMissing === "fail") {
          return Effect.fail(
            discernError(
              "replaying",
              new AiError.InvalidRequestError({
                description:
                  `No recorded observation for ${missingIds.map((id) => `"${id}"`).join(", ")}. ` +
                  "The decision definition or the input changed since the recording.",
              }),
            ),
          );
        }
        const reduced = Decision.make({ input: definition.input, decisions: missing });
        return Effect.map(inner.decide(reduced as never, { input } as never), (response) => ({
          answers: { ...hits, ...(response.answers as Answers) },
          usage: response.usage,
        }));
      }),
    );
};

/**
 * Reuse observations across runs, asking the model only for decisions that are
 * not already known. Unlike a whole-result cache this is partial: a batch of
 * four decisions with three hits sends one decision onward.
 */
export const caching =
  (into: ObservationStore): Interceptor =>
  (inner) =>
    fromDecide((definition, input) =>
      Effect.flatMap(encodeState(definition, input), (state) => {
        const { hits, missing, addresses } = split(definition, state, into);
        if (Object.keys(missing).length === 0) {
          return Effect.succeed({ answers: hits, usage: emptyUsage() });
        }
        const reduced = Decision.make({ input: definition.input, decisions: missing });
        return Effect.flatMap(CurrentScope.useSync((path) => path), (scopePath) =>
          Effect.map(inner.decide(reduced as never, { input } as never), (response) => {
            record(into, missing, addresses, response.answers as Answers, scopePath);
            return { answers: { ...hits, ...(response.answers as Answers) }, usage: response.usage };
          }),
        );
      }),
    );

export interface BudgetLimits {
  /** Maximum number of individual decisions answered by the model. */
  readonly decisions?: number | undefined;
  /** Maximum number of model round-trips. */
  readonly calls?: number | undefined;
}

export interface BudgetSpend {
  readonly decisions: number;
  readonly calls: number;
}

export interface Budget {
  readonly limits: BudgetLimits;
  readonly spent: () => BudgetSpend;
  readonly reset: () => void;
}

/** The spend hook is deliberately absent from the public `Budget` type. */
interface ChargeableBudget extends Budget {
  readonly charge: (decisions: number) => void;
}

/** A spend counter. Create one per run, then pass it to {@link budgeted}. */
export const budget = (limits: BudgetLimits): Budget => {
  let decisions = 0;
  let calls = 0;
  const self: ChargeableBudget = {
    limits,
    spent: () => ({ decisions, calls }),
    reset: () => {
      decisions = 0;
      calls = 0;
    },
    charge: (count) => {
      decisions += count;
      calls += 1;
    },
  };
  return self;
};

/**
 * Refuse model calls once a budget is spent. Place it innermost, below
 * `caching`, so that reused observations cost nothing.
 */
export const budgeted =
  (limit: Budget): Interceptor =>
  (inner) =>
    fromDecide((definition, input) => {
      const count = Object.keys(definition.decisions).length;
      const spent = limit.spent();
      const { decisions: maxDecisions, calls: maxCalls } = limit.limits;
      const exceeded =
        (maxDecisions !== undefined && spent.decisions + count > maxDecisions) ||
        (maxCalls !== undefined && spent.calls + 1 > maxCalls);
      if (exceeded) {
        return Effect.fail(
          discernError(
            "budgeted",
            new AiError.QuotaExhaustedError({
              metadata: {
                reason: "Discern budget exhausted",
                spentDecisions: spent.decisions,
                spentCalls: spent.calls,
                requestedDecisions: count,
                ...(maxDecisions === undefined ? undefined : { maxDecisions }),
                ...(maxCalls === undefined ? undefined : { maxCalls }),
              },
            }),
          ),
        );
      }
      (limit as ChargeableBudget).charge(count);
      return inner.decide(definition as never, { input } as never);
    });

// -------------------------------------------------------------------------------------------------
// Providers & layers
// -------------------------------------------------------------------------------------------------

/**
 * The raw provider contract: answer every requested decision about one encoded
 * input, in a single call. Use it to build a base model; use {@link Interceptor}
 * to decorate one that already exists.
 */
export interface Provider {
  readonly decide: (
    options: DecisionModel.ProviderOptions,
  ) => Effect.Effect<DecisionModel.ProviderResponse, AiError.AiError>;
}

/** Build a `Provider` from a plain function, for tests and adapters. */
export const provider = (decide: Provider["decide"]): Provider => ({ decide });

/**
 * A provider that refuses every call. Use it under `replaying` to prove that a
 * program reaches no model at all.
 */
export const unavailable: Provider = provider(() =>
  Effect.fail(
    discernError(
      "unavailable",
      new AiError.InvalidRequestError({
        description: "No decision provider is available; this program was expected to run without one",
      }),
    ),
  ),
);

/** A `DecisionModel` layer backed by a raw provider, with answer validation. */
export const fromProvider = (source: Provider): Layer.Layer<DecisionModel.DecisionModel> =>
  Layer.effect(DecisionModel.DecisionModel)(DecisionModel.make({ decide: source.decide }));

/**
 * Decorate an existing `DecisionModel` layer — including one from a provider
 * package you do not own.
 *
 * ```ts
 * TypeSafeDecisionModel.layer({ model: "jev-latest" }).pipe(
 *   Discern.Model.intercept([
 *     Discern.Model.recording(observations),
 *     Discern.Model.budgeted(spend)
 *   ])
 * )
 * ```
 */
export const intercept =
  (interceptors: ReadonlyArray<Interceptor>) =>
  <E, R>(self: Layer.Layer<DecisionModel.DecisionModel, E, R>): Layer.Layer<DecisionModel.DecisionModel, E, R> =>
    interceptors.length === 0
      ? self
      : Layer.effect(DecisionModel.DecisionModel)(
          DecisionModel.DecisionModel.useSync((inner) =>
            interceptors.reduceRight<DecisionModel.DecisionModel>((next, wrap) => wrap(next), inner),
          ),
        ).pipe(Layer.provide(self));

/** Build a `DecisionModel` layer from a provider and an interceptor stack. */
export const layer = (
  source: Provider,
  interceptors: ReadonlyArray<Interceptor> = [],
): Layer.Layer<DecisionModel.DecisionModel> => intercept(interceptors)(fromProvider(source));

/** A layer that answers only from recorded observations and never reaches a model. */
export const replayLayer = (source: Observations | ObservationStore): Layer.Layer<DecisionModel.DecisionModel> =>
  layer(unavailable, [replaying(source)]);

// -------------------------------------------------------------------------------------------------
// Reading a recording
// -------------------------------------------------------------------------------------------------

/** Observations grouped by the scopes they were recorded under. */
export interface ScopeTree {
  readonly name: string;
  readonly observations: ReadonlyArray<Observation>;
  readonly children: ReadonlyArray<ScopeTree>;
}

/**
 * Arrange a recording as the tree of scopes it happened in. Observations made
 * outside any {@link scope} land at the root.
 */
export const tree = (source: Observations, rootName = ""): ScopeTree => {
  const root: { name: string; observations: Array<Observation>; children: Map<string, any> } = {
    name: rootName,
    observations: [],
    children: new Map(),
  };
  for (const observation of Object.values(source.entries)) {
    let node = root;
    for (const name of observation.scope ?? []) {
      let child = node.children.get(name);
      if (child === undefined) {
        child = { name, observations: [], children: new Map() };
        node.children.set(name, child);
      }
      node = child;
    }
    node.observations.push(observation);
  }
  const freeze = (node: typeof root): ScopeTree => ({
    name: node.name,
    observations: node.observations,
    children: [...node.children.values()].map(freeze),
  });
  return freeze(root);
};
