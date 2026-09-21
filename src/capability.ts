/**
 * Capabilities: named, typed, semantically routable Effect programs.
 *
 * Discern proper is about control flow *within* a program. A capability is a
 * program the system knows how to do, and a registry chooses between several of
 * them from a request. Routing is one classification decision, so it inherits
 * Discern's treatment of uncertainty: a registry that cannot tell two
 * capabilities apart says so instead of picking the winner by a hair.
 *
 * What routing deliberately does not do is *parameterize*. `DecisionModel`
 * answers are classifications, ratings and probabilities — there is no
 * structured generation — so a registry can select a capability but never
 * construct its input. Registries are therefore homogeneous: every member
 * accepts the registry's input type. Capabilities with different inputs compose
 * statically, through ordinary Effect code.
 */
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import type * as AiError from "effect/unstable/ai/AiError";
import type * as DecisionModel from "effect/unstable/ai/DecisionModel";
import { ask, on } from "./index.js";
import type { ClassifyDecision } from "./index.js";
import * as Model from "./model.js";

const CapabilityTypeId: unique symbol = Symbol.for("discern/Capability");

// -------------------------------------------------------------------------------------------------
// Capabilities
// -------------------------------------------------------------------------------------------------

export interface Capability<
  Id extends string,
  Input,
  Output,
  Error,
  Requirements,
  InputSchema extends Schema.Constraint,
> {
  readonly [CapabilityTypeId]: typeof CapabilityTypeId;
  readonly id: Id;
  /** What this capability does. This is the text a registry routes on. */
  readonly description: string;
  /** Representative requests, included in the routing criteria when present. */
  readonly examples: ReadonlyArray<string>;
  readonly input: InputSchema;
  readonly run: (input: Input) => Effect.Effect<Output, Error, Requirements>;
}

export type Any = Capability<string, any, any, any, any, Schema.Constraint>;

export type IdOf<C> = C extends Capability<infer Id, any, any, any, any, any> ? Id : never;
export type OutputOf<C> = C extends Capability<any, any, infer O, any, any, any> ? O : never;
export type ErrorOf<C> = C extends Capability<any, any, any, infer E, any, any> ? E : never;
export type RequirementsOf<C> = C extends Capability<any, any, any, any, infer R, any> ? R : never;

/**
 * Define a capability. `run` is ordinary Effect code; it is wrapped in a
 * {@link Model.scope} so that observations made inside it are attributed to this
 * capability in a recording.
 */
export const make = <const Id extends string, S extends Schema.Constraint, Out, Err, Req>(options: {
  readonly id: Id;
  readonly description: string;
  readonly examples?: ReadonlyArray<string>;
  readonly input: S;
  readonly run: (input: S["Type"]) => Effect.Effect<Out, Err, Req>;
}): Capability<Id, S["Type"], Out, Err, Req, S> => ({
  [CapabilityTypeId]: CapabilityTypeId,
  id: options.id,
  description: options.description,
  examples: options.examples ?? [],
  input: options.input,
  run: (input) => Model.scope(options.id)(Effect.suspend(() => options.run(input))),
});

/** Wrap an existing Effect-returning function as a capability. */
export const fromEffect = <const Id extends string, S extends Schema.Constraint, Out, Err, Req>(
  id: Id,
  description: string,
  input: S,
  run: (input: S["Type"]) => Effect.Effect<Out, Err, Req>,
): Capability<Id, S["Type"], Out, Err, Req, S> => make({ id, description, input, run });

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
      /** How far ahead of the runner-up this capability was. */
      readonly margin: number;
      readonly ranked: ReadonlyArray<RouteCandidate<Ids>>;
    }
  | {
      readonly _tag: "Uncertain";
      readonly reason: string;
      readonly ranked: ReadonlyArray<RouteCandidate<Ids>>;
    };

export interface RouteOptions {
  /** The leader must reach this probability. Defaults to 0.7. */
  readonly minProbability?: number;
  /** The leader must beat the runner-up by this much. Defaults to 0.15. */
  readonly minMargin?: number;
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

export interface Registry<Members extends ReadonlyArray<Any>, S extends Schema.Constraint> {
  readonly input: S;
  readonly members: Members;
  readonly ids: ReadonlyArray<IdOf<Members[number]>>;
  readonly get: <Id extends IdOf<Members[number]>>(
    id: Id,
  ) => Extract<Members[number], { readonly id: Id }>;
  /** The classification this registry routes with, exposed for inspection and evaluation. */
  readonly decision: ClassifyDecision<S["Type"], IdOf<Members[number]>, S>;
  /**
   * Choose a capability from the whole distribution, not just the provider's
   * chosen label. Returns `Uncertain` rather than picking a near-tie.
   */
  readonly route: (
    input: S["Type"],
    options?: RouteOptions,
  ) => Effect.Effect<
    Route<IdOf<Members[number]>>,
    AiError.AiError,
    DecisionModel.DecisionModel | S["EncodingServices"]
  >;
  /** Route, then run the chosen capability. */
  readonly invoke: <Fallback = never>(
    input: S["Type"],
    options?: InvokeOptions<S["Type"], IdOf<Members[number]>, Fallback>,
  ) => Effect.Effect<
    OutputOf<Members[number]> | EffectSuccess<Fallback>,
    | ErrorOf<Members[number]>
    | EffectError<Fallback>
    | AiError.AiError
    | ([Fallback] extends [never] ? RoutingUncertainError : never),
    | RequirementsOf<Members[number]>
    | EffectRequirements<Fallback>
    | DecisionModel.DecisionModel
    | S["EncodingServices"]
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
 * Group capabilities that share an input type so a request can be routed
 * between them.
 *
 * Adding or removing a member changes the classification, and therefore
 * renormalizes every probability in it. Thresholds calibrated against an older
 * registry do not carry over — re-run `Discern.Eval` against
 * `registry.decision` when the membership changes.
 */
export const registry = <
  S extends Schema.Constraint,
  const Members extends ReadonlyArray<Capability<string, S["Type"], any, any, any, S>>,
>(
  input: S,
  members: Members,
  options: { readonly id?: string; readonly instructions?: string } = {},
): Registry<Members, S> => {
  if (members.length < 2) {
    throw new Error("Capability.registry needs at least two capabilities to route between");
  }
  const seen = new Set<string>();
  for (const member of members) {
    if (seen.has(member.id)) throw new Error(`Duplicate capability id "${member.id}" in registry`);
    seen.add(member.id);
  }

  const criteria: Record<string, string> = {};
  for (const member of members) criteria[member.id] = criterion(member);

  const decision = on(input).classify({
    ...(options.id === undefined ? undefined : { id: options.id }),
    instructions:
      options.instructions ?? "Choose the capability that best handles this request",
    criteria,
  }) as unknown as ClassifyDecision<S["Type"], IdOf<Members[number]>, S>;

  const byId = new Map(members.map((member) => [member.id, member]));
  const ids = members.map((member) => member.id) as unknown as ReadonlyArray<IdOf<Members[number]>>;

  const route = (input_: S["Type"], routeOptions: RouteOptions = {}) => {
    const minProbability = routeOptions.minProbability ?? 0.7;
    const minMargin = routeOptions.minMargin ?? 0.15;
    return Effect.map(ask(decision, input_), (answer): Route<IdOf<Members[number]>> => {
      const ranked = ids
        .map((id) => ({ id, probability: answer.probabilities[id] ?? 0 }))
        .sort((a, b) => b.probability - a.probability);
      const top = ranked[0]!;
      const margin = top.probability - (ranked[1]?.probability ?? 0);
      if (top.probability >= minProbability && margin >= minMargin) {
        return { _tag: "Matched", id: top.id, probability: top.probability, margin, ranked };
      }
      const reason =
        top.probability < minProbability
          ? `no capability reached ${minProbability} (best was ${top.id} at ${top.probability.toFixed(3)})`
          : `${top.id} led ${ranked[1]!.id} by only ${margin.toFixed(3)}, under ${minMargin}`;
      return { _tag: "Uncertain", reason, ranked };
    });
  };

  const invoke = (input_: S["Type"], invokeOptions: InvokeOptions<S["Type"], any, any> = {}) =>
    Effect.flatMap(route(input_, invokeOptions.routing), (result) => {
      if (result._tag === "Matched") {
        return byId.get(result.id)!.run(input_) as Effect.Effect<any, any, any>;
      }
      if (invokeOptions.onUncertain === undefined) {
        return Effect.fail(new RoutingUncertainError(result));
      }
      const fallback = invokeOptions.onUncertain(input_, result);
      return Effect.isEffect(fallback) ? fallback : Effect.succeed(fallback);
    });

  return {
    input,
    members,
    ids,
    get: ((id: string) => byId.get(id)) as Registry<Members, S>["get"],
    decision,
    route,
    invoke,
  } as Registry<Members, S>;
};
