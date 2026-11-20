import { createHash } from "node:crypto";

// Deterministic JSON: sorted keys, no whitespace, no undefined. Rejects values
// that cannot be hashed stably (NaN, Infinity, functions, symbols).
export function canonicalize(value) {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new Error("cannot canonicalize a non-finite number");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
      const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
      return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(",")}}`;
    }
    default:
      throw new Error(`cannot canonicalize a ${typeof value}`);
  }
}

export const sha256Hex = input => createHash("sha256").update(input).digest("hex");
export const hashJson = value => sha256Hex(canonicalize(value));
