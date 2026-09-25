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
 * validated ones. Answers read back from a store are validated again by the
 * same rules, because a store can be loaded from a file.
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

/**
 * True for the failure raised when an answer read back from a store fails
 * validation, as a hand-edited or corrupted recording can.
 */
export const isInvalidObservation = (error: unknown): error is AiError.AiError =>
  error instanceof AiError.AiError && error.module === "Discern" && error.method === "observation";

// -------------------------------------------------------------------------------------------------
// Observations
// -------------------------------------------------------------------------------------------------

/**
 * The enclosing region stack. It has a default, so it never appears in an
 * Effect's requirements.
 */
export const CurrentRegion = Context.Reference<ReadonlyArray<string>>("discern/CurrentRegion", {
  defaultValue: () => [],
});

/**
 * Name a region of a program so that observations recorded inside it are
 * attributed to it. Regions nest, which is what turns a flat store into a tree.
 *
 * This is deliberately not called a scope: Effect's `Scope` is about resource
 * lifetime, and this is only about attribution.
 */
export const region =
  (name: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.flatMap(CurrentRegion.useSync((path) => path), (parent) =>
      Effect.provideService(effect, CurrentRegion, [...parent, name]),
    );

/**
 * One recorded semantic answer, with enough context to read it unaided.
 *
 * - `decisionId`: the decision's name in the batch it was requested in.
 *   Diagnostic only.
 * - `fingerprint`: the decision definition's fingerprint. Diagnostic only; the
 *   address already pins it.
 * - `region`: the region stack this observation was recorded under. An
 *   observation is content-addressed, so one entry covers every place the same
 *   decision was asked about the same input, and only one region can be kept.
 *   `recording` sees every call and so moves the entry to the newest region;
 *   `caching` writes only on a miss, so under `caching` alone the entry keeps
 *   the region that first missed. For a faithful per-run tree, record each run
 *   into its own store.
 * - `answer`: a validated `Decision.Answer`. `replaying` and `caching`
 *   validate it again when they read it back, since a store can be loaded from
 *   a file that was edited after it was recorded.
 */
export const Observation = Schema.Struct({
  decisionId: Schema.String,
  fingerprint: Schema.String,
  kind: Schema.Literals(["Classify", "Rate", "Probability"]),
  region: Schema.Array(Schema.String),
  answer: Schema.Unknown,
});
export type Observation = typeof Observation.Type;

/**
 * A serializable set of observations, keyed by content address.
 *
 * A snapshot is plain JSON. Decode one read back from outside the program
 * rather than casting it, so a malformed or older recording is refused at the
 * boundary instead of replaying wrong:
 *
 * ```ts
 * const recorded = Schema.decodeUnknownSync(Discern.Model.Observations)(JSON.parse(text))
 * ```
 */
export const Observations = Schema.Struct({
  version: Schema.Literal(2),
  entries: Schema.Record(Schema.String, Observation),
});
export type Observations = typeof Observations.Type;

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

const checkVersion = (observations: Observations): Observations => {
  if (observations.version !== 2) {
    throw new Error(
      `Unsupported observation format v${observations.version}; addresses are not comparable across versions`,
    );
  }
  return observations;
};

export const store = (initial?: Observations): MemoryStore => {
  const values = new Map<string, Observation>(
    initial ? Object.entries(checkVersion(initial).entries) : undefined,
  );
  return {
    get: (address) => values.get(address),
    set: (address, observation) => void values.set(address, observation),
    snapshot: () => ({ version: 2, entries: Object.fromEntries(values) }),
    /** Replaces the contents, so a snapshot round-trips exactly. Use `set` to merge. */
    load: (observations) => {
      values.clear();
      for (const [address, observation] of Object.entries(checkVersion(observations).entries)) {
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
  const hits: Answers = Object.create(null);
  const missing: Record<string, Decision.Any> = Object.create(null);
  const addresses: Record<string, string> = Object.create(null);
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
  regionPath: ReadonlyArray<string>,
): void => {
  for (const [id, decision] of Object.entries(decisions)) {
    const answer = answers[id];
    if (answer === undefined) continue;
    into.set(addresses[id]!, {
      decisionId: id,
      fingerprint: decisionFingerprint(decision),
      kind: decision._tag,
      region: regionPath,
      answer,
    });
  }
};

/**
 * Validate answers read from a store by the same rules `DecisionModel.make`
 * applies to a provider.
 *
 * A stored answer was validated when it was recorded, but a store can be loaded
 * from a file, so by the time it is read back it may have been edited or
 * corrupted. Interceptors sit above validation, so without this a probability
 * of 7 would be replayed as a confident answer.
 */
const validateStored = (
  decisions: Record<string, Decision.Any>,
  hits: Answers,
): Effect.Effect<Answers, AiError.AiError> => {
  const ids = Object.keys(hits);
  if (ids.length === 0) return Effect.succeed(hits);
  const asked: Record<string, Decision.Any> = Object.create(null);
  // A stored answer is in validated form, which drops the provider's `_tag`.
  // Restore it from the decision so the provider-side rules apply unchanged.
  const tagged: Record<string, unknown> = Object.create(null);
  for (const id of ids) {
    const decision = decisions[id]!;
    const answer = hits[id];
    asked[id] = decision;
    tagged[id] = answer !== null && typeof answer === "object" ? { ...answer, _tag: decision._tag } : answer;
  }
  const stored = DecisionModel.make({
    decide: () =>
      Effect.succeed({
        answers: tagged as DecisionModel.ProviderResponse["answers"],
        usage: { inputTokens: undefined, outputTokens: undefined },
      }),
  });
  return Effect.flatMap(stored, (model) =>
    model.decide(Decision.make({ input: Schema.Null, decisions: asked }), { input: null }),
  ).pipe(
    Effect.map((response) => response.answers as Answers),
    Effect.mapError((error) =>
      discernError(
        "observation",
        new AiError.InvalidOutputError({
          description: `A stored observation failed validation: ${
            error.reason._tag === "InvalidOutputError" ? error.reason.description : error.message
          }`,
        }),
      ),
    ),
  );
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
        return Effect.flatMap(CurrentRegion.useSync((path) => path), (regionPath) =>
          Effect.map(inner.decide(definition as never, { input } as never), (response) => {
            record(into, definition.decisions, addresses, response.answers as Answers, regionPath);
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
/**
 * `onMissing: "ask"` passes unrecorded decisions through to the model but does
 * not write them back — `replaying` only reads. To top up a recording as you
 * go, put a cache underneath it:
 * `[replaying(fixture, { onMissing: "ask" }), caching(store)]`.
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
        const { hits: stored, missing } = split(definition, state, lookup);
        const missingIds = Object.keys(missing);
        if (missingIds.length > 0 && onMissing === "fail") {
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
        return Effect.flatMap(validateStored(definition.decisions, stored), (hits) => {
          if (missingIds.length === 0) return Effect.succeed({ answers: hits, usage: emptyUsage() });
          const reduced = Decision.make({ input: definition.input, decisions: missing });
          return Effect.map(inner.decide(reduced as never, { input } as never), (response) => ({
            answers: { ...hits, ...(response.answers as Answers) },
            usage: response.usage,
          }));
        });
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
        const { hits: stored, missing, addresses } = split(definition, state, into);
        return Effect.flatMap(validateStored(definition.decisions, stored), (hits) => {
          if (Object.keys(missing).length === 0) {
            return Effect.succeed({ answers: hits, usage: emptyUsage() });
          }
          const reduced = Decision.make({ input: definition.input, decisions: missing });
          return Effect.flatMap(CurrentRegion.useSync((path) => path), (regionPath) =>
            Effect.map(inner.decide(reduced as never, { input } as never), (response) => {
              record(into, missing, addresses, response.answers as Answers, regionPath);
              return { answers: { ...hits, ...(response.answers as Answers) }, usage: response.usage };
            }),
          );
        });
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

const BudgetTypeId: unique symbol = Symbol.for("discern/Budget");

/**
 * A spend counter. Only {@link budget} can make one: the counter it increments
 * is private, so a structurally similar object would typecheck and then fail at
 * runtime.
 */
export interface Budget {
  readonly [BudgetTypeId]: typeof BudgetTypeId;
  readonly limits: BudgetLimits;
  readonly spent: () => BudgetSpend;
  readonly reset: () => void;
}

interface ChargeableBudget extends Budget {
  readonly charge: (decisions: number) => void;
}

/** Create a spend counter, one per run, then pass it to {@link budgeted}. */
export const budget = (limits: BudgetLimits): Budget => {
  let decisions = 0;
  let calls = 0;
  const self: ChargeableBudget = {
    [BudgetTypeId]: BudgetTypeId,
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

/** Observations grouped by the regions they were recorded under. */
export interface RegionTree {
  readonly name: string;
  readonly observations: ReadonlyArray<Observation>;
  readonly children: ReadonlyArray<RegionTree>;
}

/**
 * Arrange a recording as the tree of regions it happened in. Observations made
 * outside any {@link region} land at the root.
 */
export const tree = (source: Observations, rootName = ""): RegionTree => {
  const root: { name: string; observations: Array<Observation>; children: Map<string, any> } = {
    name: rootName,
    observations: [],
    children: new Map(),
  };
  for (const observation of Object.values(source.entries)) {
    let node = root;
    for (const name of observation.region ?? []) {
      let child = node.children.get(name);
      if (child === undefined) {
        child = { name, observations: [], children: new Map() };
        node.children.set(name, child);
      }
      node = child;
    }
    node.observations.push(observation);
  }
  const freeze = (node: typeof root): RegionTree => ({
    name: node.name,
    observations: node.observations,
    children: [...node.children.values()].map(freeze),
  });
  return freeze(root);
};
