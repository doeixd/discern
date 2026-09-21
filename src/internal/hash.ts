/**
 * Stable structural hashing, shared by decision fingerprints, plan fingerprints
 * and content-addressed observations.
 */
import type * as Decision from "effect/unstable/ai/Decision";

const canonical = (value: unknown, sortKeys: boolean): string => {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item, sortKeys)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return `{${(sortKeys ? [...keys].sort() : keys)
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key], sortKeys)}`)
    .join(",")}}`;
};

/**
 * A canonical string for any JSON-like value, treating objects as unordered.
 *
 * Use this for *data*: a JSON object's key order carries no meaning, so
 * `{b, a}` and `{a, b}` are the same input and should hash alike. Array order
 * is always preserved, because it is meaningful.
 */
export const stable = (value: unknown): string => canonical(value, true);

/**
 * A canonical string that preserves key order.
 *
 * Use this for *decisions*. A classification's criteria reach the provider in
 * declaration order, so reordering them can change the answer. Hashing them as
 * written means a reorder is a cache miss (costing one model call) rather than
 * a silent reuse of an answer produced under a different prompt.
 */
export const stableOrdered = (value: unknown): string => canonical(value, false);

/**
 * Two independently seeded FNV-1a lanes, concatenated. Fingerprints gate replay
 * and cache reuse, so 32 bits is not enough margin to treat a match as proof
 * that a decision definition is unchanged.
 */
export const hash = (value: unknown): string => {
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

/** Identity of a decision *definition* — instructions and criteria, not its id. */
export const decisionFingerprint = (value: Decision.Any): string => `df_${hash(stableOrdered(value))}`;

/**
 * Content address of one semantic observation: the decision definition together
 * with the encoded input it was asked about.
 *
 * Addressing by definition-and-input rather than by decision id is what lets a
 * single store hold observations from many matchers, and from the same decision
 * asked about different inputs, without collisions.
 */
export const observationAddress = (decision: Decision.Any, state: unknown): string =>
  `o_${hash(`${stableOrdered(decision)}|${stable(state)}`)}`;
