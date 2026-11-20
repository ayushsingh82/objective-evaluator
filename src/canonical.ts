import { createHash } from "node:crypto";

/**
 * Deterministic JSON: sorted keys, no whitespace, no undefined. Rejects values
 * that cannot be hashed stably (NaN, Infinity, functions, symbols, bigint).
 */
export function canonicalize(value: unknown): string {
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
      if (Array.isArray(value)) return `[${value.map(item => canonicalize(item)).join(",")}]`;
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).filter(k => record[k] !== undefined).sort();
      return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalize(record[k])}`).join(",")}}`;
    }
    default:
      throw new Error(`cannot canonicalize a ${typeof value}`);
  }
}

export const sha256Hex = (input: string | Uint8Array): string => createHash("sha256").update(input).digest("hex");
export const hashJson = (value: unknown): string => sha256Hex(canonicalize(value));
