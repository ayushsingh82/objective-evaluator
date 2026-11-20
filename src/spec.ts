import { hashJson } from "./canonical.ts";
import type { Spec } from "./types.ts";

export const CHECK_TYPES = ["url_up", "github_pr_merged", "github_checks_pass", "file_hash", "manual"] as const;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// Untrusted input is probed property by property, so it is typed loosely here and
// narrowed to `Spec` by the assertion signature once every rule has passed.
type Loose = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Throws with every problem found; narrows `spec` to `Spec` when valid. */
export function validateSpec(spec: unknown): asserts spec is Spec {
  const errors: string[] = [];
  if (!spec || typeof spec !== "object") throw new Error("spec must be an object");
  const s = spec as Loose;
  if (s.version !== 1) errors.push("version must be 1");
  if (typeof s.title !== "string" || !s.title) errors.push("title is required");
  if (typeof s.deadline !== "string" || Number.isNaN(Date.parse(s.deadline))) {
    errors.push("deadline must be an ISO date-time string");
  }
  if (!Array.isArray(s.checks) || s.checks.length === 0) {
    errors.push("checks must be a non-empty array");
  } else {
    const seen = new Set<string>();
    for (const [i, check] of (s.checks as Loose[]).entries()) {
      const at = `checks[${i}]`;
      if (!check || typeof check !== "object") { errors.push(`${at} must be an object`); continue; }
      if (typeof check.id !== "string" || !ID.test(check.id)) errors.push(`${at}.id must match ${ID}`);
      else if (seen.has(check.id)) errors.push(`${at}.id "${check.id}" is duplicated`);
      else seen.add(check.id);
      if (!(CHECK_TYPES as readonly string[]).includes(check.type)) errors.push(`${at}.type must be one of ${CHECK_TYPES.join(", ")}`);
      if (check.required !== undefined && typeof check.required !== "boolean") errors.push(`${at}.required must be boolean`);
      if ((check.type === "github_pr_merged" || check.type === "github_checks_pass") && !/^[\w.-]+\/[\w.-]+$/.test(check.repo ?? "")) {
        errors.push(`${at}.repo must look like owner/name`);
      }
      if (check.type === "github_checks_pass" && check.names !== undefined &&
          !(Array.isArray(check.names) && check.names.length > 0 && check.names.every((n: unknown) => typeof n === "string" && n))) {
        errors.push(`${at}.names must be a non-empty array of check names`);
      }
      if (check.type === "file_hash" && !/^[0-9a-f]{64}$/.test(check.sha256 ?? "")) {
        errors.push(`${at}.sha256 must be 64 lowercase hex characters`);
      }
      if (check.type === "manual" && typeof check.question !== "string") errors.push(`${at}.question is required`);
    }
  }
  if (s.judges !== undefined &&
      !(Array.isArray(s.judges) && s.judges.length > 0 && s.judges.every((j: unknown) => typeof j === "string" && j))) {
    errors.push("judges must be a non-empty array of names allowed to resolve manual checks");
  }
  if (Array.isArray(s.checks) && s.checks.length) {
    const required = (s.checks as Loose[]).filter(c => c && c.required !== false);
    if (required.length === 0) {
      errors.push("at least one check must be required (otherwise any evidence is an 'achieved' verdict)");
    } else if (required.every(c => c.type === "manual")) {
      // Deterministic anchor: a verdict that rests only on human say-so is not an evaluator, it is a vote.
      errors.push("at least one required check must be machine-verifiable (not manual), so judgment can never be the only gate");
    }
  }
  if (errors.length) throw new Error(`invalid spec:\n- ${errors.join("\n- ")}`);
}

export function specHash(spec: unknown): string {
  validateSpec(spec);
  return hashJson(spec);
}
