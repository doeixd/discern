/**
 * Stable structural hashing, shared by decision fingerprints, plan fingerprints
 * and content-addressed observations.
 */
import type * as Decision from "effect/unstable/ai/Decision";

/**
 * A canonical string for any JSON-like value. Object keys are sorted so that
 * declaration order never changes a fingerprint; array order is preserved
 * because it is meaningful (an ordered `Rate` scale, for instance).
 */
export const stable = (value: unknown): string => {
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
export const decisionFingerprint = (value: Decision.Any): string => `df_${hash(value)}`;

/**
 * Content address of one semantic observation: the decision definition together
 * with the encoded input it was asked about.
 *
 * Addressing by definition-and-input rather than by decision id is what lets a
 * single store hold observations from many matchers, and from the same decision
 * asked about different inputs, without collisions.
 */
export const observationAddress = (decision: Decision.Any, state: unknown): string =>
  `o_${hash({ decision, state })}`;
