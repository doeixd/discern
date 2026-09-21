/**
 * Procedures: named, typed, semantically routable Effect programs.
 *
 * Discern proper is about control flow *within* a program. A procedure is a
 * named entry point with a described purpose and a typed input, and a registry
 * chooses between several of them from a request. Routing is one classification decision, so it inherits
 * Discern's treatment of uncertainty: a registry that cannot tell two
 * procedures apart says so instead of picking the winner by a hair.
 *
 * What routing deliberately does not do is *parameterize*. `DecisionModel`
 * answers are classifications, ratings and probabilities — there is no
 * structured generation — so a registry can select a procedure but never
 * construct its input. Registries are therefore homogeneous: every member
 * accepts the registry's input type. Procedures with different inputs compose
 * statically, through ordinary Effect code.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import type * as AiError from "effect/unstable/ai/AiError";
import type * as DecisionModel from "effect/unstable/ai/DecisionModel";
import { ask, on } from "./index.js";
import type { ClassifyDecision } from "./index.js";
import * as Model from "./model.js";

const ProcedureTypeId: unique symbol = Symbol.for("discern/Procedure");

// -------------------------------------------------------------------------------------------------
// Procedures
// -------------------------------------------------------------------------------------------------

export interface Procedure<
  Id extends string,
  Input,
  Output,
  Error,
  Requirements,
  InputSchema extends Schema.Constraint,
> {
  readonly [ProcedureTypeId]: typeof ProcedureTypeId;
  readonly id: Id;
  /** What this procedure does. This is the text a registry routes on. */
  readonly description: string;
  /** Representative requests, included in the routing criteria when present. */
  readonly examples: ReadonlyArray<string>;
  readonly input: InputSchema;
  /**
   * A deterministic precondition. A procedure that cannot apply to an input is
   * removed before the model is asked, on the same principle as
   * `Discern.deterministic`: do not ask about possibilities ordinary code has
   * already ruled out.
   */
  readonly eligible: (input: Input) => boolean;
  readonly run: (input: Input) => Effect.Effect<Output, Error, Requirements>;
}

export type Any = Procedure<string, any, any, any, any, Schema.Constraint>;

export type IdOf<C> = C extends Procedure<infer Id, any, any, any, any, any> ? Id : never;
export type OutputOf<C> = C extends Procedure<any, any, infer O, any, any, any> ? O : never;
export type ErrorOf<C> = C extends Procedure<any, any, any, infer E, any, any> ? E : never;
export type RequirementsOf<C> = C extends Procedure<any, any, any, any, infer R, any> ? R : never;

/**
 * Define a procedure. `run` is ordinary Effect code; it is wrapped in a
 * {@link Model.region} so that observations made inside it are attributed to this
 * procedure in a recording.
 */
export const make = <const Id extends string, S extends Schema.Constraint, Out, Err, Req>(options: {
  readonly id: Id;
  readonly description: string;
  readonly examples?: ReadonlyArray<string>;
  readonly input: S;
  /** A deterministic precondition; without one the procedure always applies. */
  readonly eligible?: (input: S["Type"]) => boolean;
  readonly run: (input: S["Type"]) => Effect.Effect<Out, Err, Req>;
}): Procedure<Id, S["Type"], Out, Err, Req, S> => ({
  [ProcedureTypeId]: ProcedureTypeId,
  id: options.id,
  description: options.description,
  examples: options.examples ?? [],
  input: options.input,
  eligible: options.eligible ?? (() => true),
  run: (input) => Model.region(options.id)(Effect.suspend(() => options.run(input))),
});

/** Wrap an existing Effect-returning function as a procedure. */
export const fromEffect = <const Id extends string, S extends Schema.Constraint, Out, Err, Req>(
  id: Id,
  description: string,
  input: S,
  run: (input: S["Type"]) => Effect.Effect<Out, Err, Req>,
): Procedure<Id, S["Type"], Out, Err, Req, S> => make({ id, description, input, run });

// -------------------------------------------------------------------------------------------------
// Routing
// -------------------------------------------------------------------------------------------------

export interface RouteCandidate<Ids extends string> {
  readonly id: Ids;
  readonly probability: number;
}

export type Route<Ids extends string> =
  | {
      readonly _tag: "Matched";
      readonly id: Ids;
      readonly probability: number;
      /** How far ahead of the runner-up this procedure was. */
      readonly margin: number;
      /**
       * `elimination` when eligibility left exactly one candidate, so no model
       * was consulted at all.
       */
      readonly by: "model" | "elimination";
      readonly ranked: ReadonlyArray<RouteCandidate<Ids>>;
    }
  | {
      readonly _tag: "Uncertain";
      readonly reason: string;
      readonly ranked: ReadonlyArray<RouteCandidate<Ids>>;
    }
  | {
      /**
       * Eligibility ruled every procedure out. This is a deterministic fact,
       * not uncertainty, so it is kept separate from `Uncertain`.
       */
      readonly _tag: "None";
      readonly reason: string;
    };

export interface RouteOptions {
  /** The leader must reach this probability. Defaults to 0.7. */
  readonly minProbability?: number;
  /** The leader must beat the runner-up by this much. Defaults to 0.15. */
  readonly minMargin?: number;
}

/**
 * How many nested `invoke` calls deep the current program is. Static `run`
 * calls are bounded by the code that makes them; only routing can recurse
 * without a fixed bottom, so only routing is counted.
 */
export const CurrentDepth = Context.Reference<number>("discern/ProcedureDepth", {
  defaultValue: () => 0,
});

/** The ceiling `invoke` enforces. Defaults to 8. */
export const MaxDepth = Context.Reference<number>("discern/ProcedureMaxDepth", {
  defaultValue: () => 8,
});

/** Set the nested-`invoke` ceiling for a program. */
export const withMaxDepth =
  (limit: number) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.provideService(effect, MaxDepth, limit);

export class DepthExceededError extends Error {
  readonly _tag = "DepthExceededError";
  override readonly name = "DepthExceededError";
  constructor(
    readonly depth: number,
    readonly limit: number,
  ) {
    super(`Procedure routing reached depth ${depth}, at the limit of ${limit}`);
  }
}

export class NoEligibleProcedureError extends Error {
  readonly _tag = "NoEligibleProcedureError";
  override readonly name = "NoEligibleProcedureError";
  constructor(override readonly message: string) {
    super(message);
  }
}

export class RoutingUncertainError extends Error {
  readonly _tag = "RoutingUncertainError";
  override readonly name = "RoutingUncertainError";
  constructor(readonly route: Extract<Route<string>, { _tag: "Uncertain" }>) {
    super(`Could not route the request confidently: ${route.reason}`);
  }
}

export interface InvokeOptions<Input, Ids extends string, Fallback> {
  readonly routing?: RouteOptions;
  /**
   * Handle a request the registry could not route. Without one, an unroutable
   * request fails with {@link RoutingUncertainError} rather than guessing.
   */
  readonly onUncertain?: (
    input: Input,
    route: Extract<Route<Ids>, { _tag: "Uncertain" }>,
  ) => Fallback;
}

// -------------------------------------------------------------------------------------------------
// Registry
// -------------------------------------------------------------------------------------------------

/**
 * How the model sees a request when routing.
 *
 * A procedure consumes the whole input; a router only needs enough of it to
 * choose. Projecting keeps large evidence — a diff, a document, a transcript —
 * out of the routing prompt, which cuts tokens and raises signal.
 */
export interface RouteBy<S extends Schema.Constraint, R extends Schema.Constraint> {
  readonly schema: R;
  readonly select: (input: S["Type"]) => R["Type"];
}

export interface Registry<
  Members extends ReadonlyArray<Any>,
  S extends Schema.Constraint,
  RouteInput extends Schema.Constraint = S,
> {
  readonly input: S;
  /** The schema the routing decision actually sees. Equal to `input` unless projected. */
  readonly routeInput: RouteInput;
  readonly members: Members;
  readonly ids: ReadonlyArray<IdOf<Members[number]>>;
  readonly get: <Id extends IdOf<Members[number]>>(
    id: Id,
  ) => Extract<Members[number], { readonly id: Id }>;
  /**
   * The classification for the full membership, exposed for inspection and
   * evaluation. Eligibility may narrow the set actually asked about at run time.
   */
  readonly decision: ClassifyDecision<RouteInput["Type"], IdOf<Members[number]>, RouteInput>;
  /**
   * Choose a procedure from the whole distribution, not just the provider's
   * chosen label. Returns `Uncertain` rather than picking a near-tie, and
   * `None` when eligibility ruled everything out.
   */
  readonly route: (
    input: S["Type"],
    options?: RouteOptions,
  ) => Effect.Effect<
    Route<IdOf<Members[number]>>,
    AiError.AiError,
    DecisionModel.DecisionModel | RouteInput["EncodingServices"]
  >;
  /** Route, then run the chosen procedure. */
  readonly invoke: <Fallback = never>(
    input: S["Type"],
    options?: InvokeOptions<S["Type"], IdOf<Members[number]>, Fallback>,
  ) => Effect.Effect<
    OutputOf<Members[number]> | EffectSuccess<Fallback>,
    | ErrorOf<Members[number]>
    | EffectError<Fallback>
    | AiError.AiError
    | NoEligibleProcedureError
    | DepthExceededError
    | ([Fallback] extends [never] ? RoutingUncertainError : never),
    | RequirementsOf<Members[number]>
    | EffectRequirements<Fallback>
    | DecisionModel.DecisionModel
    | RouteInput["EncodingServices"]
  >;
  /**
   * As {@link invoke}, but also returns the routing decision itself. In an
   * agent or workflow the choice is often as interesting as the result.
   */
  readonly invokeWithRoute: <Fallback = never>(
    input: S["Type"],
    options?: InvokeOptions<S["Type"], IdOf<Members[number]>, Fallback>,
  ) => Effect.Effect<
    {
      readonly route: Route<IdOf<Members[number]>>;
      readonly value: OutputOf<Members[number]> | EffectSuccess<Fallback>;
    },
    | ErrorOf<Members[number]>
    | EffectError<Fallback>
    | AiError.AiError
    | NoEligibleProcedureError
    | DepthExceededError
    | ([Fallback] extends [never] ? RoutingUncertainError : never),
    | RequirementsOf<Members[number]>
    | EffectRequirements<Fallback>
    | DecisionModel.DecisionModel
    | RouteInput["EncodingServices"]
  >;
}

type EffectSuccess<T> = T extends Effect.Effect<infer A, any, any> ? A : T;
type EffectError<T> = T extends Effect.Effect<any, infer E, any> ? E : never;
type EffectRequirements<T> = T extends Effect.Effect<any, any, infer R> ? R : never;

const criterion = (member: Any): string =>
  member.examples.length === 0
    ? member.description
    : `${member.description}. For example: ${member.examples.join("; ")}`;

/**
 * Group procedures that share an input type so a request can be routed
 * between them.
 *
 * Adding or removing a member changes the classification, and therefore
 * renormalizes every probability in it. Thresholds calibrated against an older
 * registry do not carry over — re-run `Discern.Eval` against
 * `registry.decision` when the membership changes.
 */
export const registry = <
  S extends Schema.Constraint,
  const Members extends ReadonlyArray<Procedure<string, S["Type"], any, any, any, S>>,
  RouteInput extends Schema.Constraint = S,
>(
  input: S,
  members: Members,
  options: {
    readonly id?: string;
    readonly instructions?: string;
    /** Route on a projection of the input rather than the whole of it. */
    readonly routeBy?: RouteBy<S, RouteInput>;
  } = {},
): Registry<Members, S, RouteInput> => {
  if (members.length < 2) {
    throw new Error("Procedure.registry needs at least two procedures to route between");
  }
  const seen = new Set<string>();
  for (const member of members) {
    if (seen.has(member.id)) throw new Error(`Duplicate procedure id "${member.id}" in registry`);
    seen.add(member.id);
  }

  const routeInput = (options.routeBy?.schema ?? input) as RouteInput;
  const select = options.routeBy?.select ?? ((value: S["Type"]) => value as RouteInput["Type"]);
  const instructions =
    options.instructions ?? "Choose the procedure that best handles this request";

  const byId = new Map(members.map((member) => [member.id, member]));
  const ids = members.map((member) => member.id) as unknown as ReadonlyArray<IdOf<Members[number]>>;

  /**
   * Eligibility can narrow the candidates per input, so the classification is
   * built per distinct candidate set and memoized. Only the full set gets the
   * caller's explicit id; a narrowed set is a different question and must not
   * claim the same identity.
   */
  const decisions = new Map<string, ClassifyDecision<any, any, any>>();
  const decisionFor = (candidates: ReadonlyArray<string>) => {
    const key = candidates.join(" ");
    let found = decisions.get(key);
    if (found === undefined) {
      const criteria: Record<string, string> = Object.create(null);
      for (const id of candidates) criteria[id] = criterion(byId.get(id)!);
      const whole = candidates.length === members.length;
      found = on(routeInput).classify({
        ...(options.id === undefined || !whole ? undefined : { id: options.id }),
        instructions,
        criteria,
      }) as ClassifyDecision<any, any, any>;
      decisions.set(key, found);
    }
    return found;
  };

  const decision = decisionFor(members.map((member) => member.id)) as unknown as ClassifyDecision<
    RouteInput["Type"],
    IdOf<Members[number]>,
    RouteInput
  >;

  const route = (input_: S["Type"], routeOptions: RouteOptions = {}) => {
    const minProbability = routeOptions.minProbability ?? 0.7;
    const minMargin = routeOptions.minMargin ?? 0.15;
    type R = Route<IdOf<Members[number]>>;
    const as = (value: unknown) => value as R;

    const eligible = members.filter((member) => member.eligible(input_));

    if (eligible.length === 0) {
      return Effect.succeed(
        as({
          _tag: "None",
          reason: `no procedure is eligible for this input (of ${ids.join(", ")})`,
        }),
      );
    }
    // One candidate left is not a question worth asking a model.
    if (eligible.length === 1) {
      const only = eligible[0]!;
      return Effect.succeed(
        as({
          _tag: "Matched",
          id: only.id,
          probability: 1,
          margin: 1,
          by: "elimination",
          ranked: [{ id: only.id, probability: 1 }],
        }),
      );
    }

    const candidates = eligible.map((member) => member.id);
    return Effect.map(
      Model.region("route")(ask(decisionFor(candidates), select(input_))),
      (answer): R => {
        const ranked = candidates
          .map((id) => ({ id, probability: answer.probabilities[id] ?? 0 }))
          .sort((a, b) => b.probability - a.probability);
        const top = ranked[0]!;
        const margin = top.probability - (ranked[1]?.probability ?? 0);
        if (top.probability >= minProbability && margin >= minMargin) {
          return as({
            _tag: "Matched",
            id: top.id,
            probability: top.probability,
            margin,
            by: "model",
            ranked,
          });
        }
        const reason =
          top.probability < minProbability
            ? `no procedure reached ${minProbability} (best was ${top.id} at ${top.probability.toFixed(3)})`
            : `${top.id} led ${ranked[1]!.id} by only ${margin.toFixed(3)}, under ${minMargin}`;
        return as({ _tag: "Uncertain", reason, ranked });
      },
    );
  };

  type Dispatched = { readonly route: Route<IdOf<Members[number]>>; readonly value: any };

  const dispatch = (
    input_: S["Type"],
    invokeOptions: InvokeOptions<S["Type"], any, any>,
  ): Effect.Effect<Dispatched, any, any> =>
    Effect.flatMap(route(input_, invokeOptions.routing), (result): Effect.Effect<Dispatched, any, any> => {
      if (result._tag === "Matched") {
        return Effect.map(
          byId.get(result.id)!.run(input_) as Effect.Effect<any, any, any>,
          (value): Dispatched => ({ route: result, value }),
        );
      }
      if (result._tag === "None") {
        return Effect.fail(new NoEligibleProcedureError(result.reason));
      }
      if (invokeOptions.onUncertain === undefined) {
        return Effect.fail(new RoutingUncertainError(result));
      }
      const fallback = invokeOptions.onUncertain(input_, result);
      return Effect.map(
        (Effect.isEffect(fallback) ? fallback : Effect.succeed(fallback)) as Effect.Effect<any, any, any>,
        (value): Dispatched => ({ route: result, value }),
      );
    });

  const invokeWithRoute = (input_: S["Type"], invokeOptions: InvokeOptions<S["Type"], any, any> = {}) =>
    Effect.flatMap(CurrentDepth.useSync((depth) => depth), (depth) =>
      Effect.flatMap(MaxDepth.useSync((limit) => limit), (limit) =>
        depth >= limit
          ? Effect.fail(new DepthExceededError(depth, limit))
          : Effect.provideService(dispatch(input_, invokeOptions), CurrentDepth, depth + 1),
      ),
    );

  const invoke = (input_: S["Type"], invokeOptions: InvokeOptions<S["Type"], any, any> = {}) =>
    Effect.map(invokeWithRoute(input_, invokeOptions), (result: Dispatched) => result.value);

  return {
    input,
    routeInput,
    members,
    ids,
    get: ((id: string) => {
      const member = byId.get(id);
      if (member === undefined) {
        throw new Error(`No procedure "${id}" in this registry (have: ${ids.join(", ")})`);
      }
      return member;
    }) as Registry<Members, S, RouteInput>["get"],
    decision,
    route,
    invoke,
    invokeWithRoute,
  } as Registry<Members, S, RouteInput>;
};

/**
 * Present a registry as a procedure, so registries nest.
 *
 * A flat classification gets vague past roughly eight members: the criteria
 * grow into a long prompt and the probabilities spread thin. Grouping related
 * procedures behind one entry keeps each routing decision a short, sharp
 * question, and nothing new is needed to do it — a registry-as-procedure is
 * just another member of its parent.
 */
export const fromRegistry = <
  const Id extends string,
  S extends Schema.Constraint,
  const Members extends ReadonlyArray<Procedure<string, S["Type"], any, any, any, S>>,
>(options: {
  readonly id: Id;
  readonly description: string;
  readonly examples?: ReadonlyArray<string>;
  readonly registry: Registry<Members, S>;
  readonly routing?: RouteOptions;
}): Procedure<
  Id,
  S["Type"],
  OutputOf<Members[number]>,
  | ErrorOf<Members[number]>
  | AiError.AiError
  | RoutingUncertainError
  | NoEligibleProcedureError
  | DepthExceededError,
  RequirementsOf<Members[number]> | DecisionModel.DecisionModel | S["EncodingServices"],
  S
> =>
  make({
    id: options.id,
    description: options.description,
    ...(options.examples === undefined ? undefined : { examples: options.examples }),
    input: options.registry.input,
    run: (input) =>
      options.registry.invoke(input, {
        ...(options.routing === undefined ? undefined : { routing: options.routing }),
      }) as Effect.Effect<any, any, any>,
  }) as any;
