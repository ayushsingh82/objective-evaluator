export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Narrows untrusted input to a plain object, or an empty one. */
export const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
