import { hashJson } from "./canonical.js";

export const CHECK_TYPES = ["url_up", "github_pr_merged", "github_checks_pass", "file_hash", "manual"];
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Throws with every problem found; returns the spec when valid. */
export function validateSpec(spec) {
  const errors = [];
  if (!spec || typeof spec !== "object") throw new Error("spec must be an object");
  if (spec.version !== 1) errors.push("version must be 1");
  if (typeof spec.title !== "string" || !spec.title) errors.push("title is required");
  if (typeof spec.deadline !== "string" || Number.isNaN(Date.parse(spec.deadline))) {
    errors.push("deadline must be an ISO date-time string");
  }
  if (!Array.isArray(spec.checks) || spec.checks.length === 0) {
    errors.push("checks must be a non-empty array");
  } else {
    const seen = new Set();
    for (const [i, check] of spec.checks.entries()) {
      const at = `checks[${i}]`;
      if (!check || typeof check !== "object") { errors.push(`${at} must be an object`); continue; }
      if (typeof check.id !== "string" || !ID.test(check.id)) errors.push(`${at}.id must match ${ID}`);
      else if (seen.has(check.id)) errors.push(`${at}.id "${check.id}" is duplicated`);
      else seen.add(check.id);
      if (!CHECK_TYPES.includes(check.type)) errors.push(`${at}.type must be one of ${CHECK_TYPES.join(", ")}`);
      if (check.required !== undefined && typeof check.required !== "boolean") errors.push(`${at}.required must be boolean`);
      if ((check.type === "github_pr_merged" || check.type === "github_checks_pass") && !/^[\w.-]+\/[\w.-]+$/.test(check.repo ?? "")) {
        errors.push(`${at}.repo must look like owner/name`);
      }
      if (check.type === "github_checks_pass" && check.names !== undefined &&
          !(Array.isArray(check.names) && check.names.length > 0 && check.names.every(n => typeof n === "string" && n))) {
        errors.push(`${at}.names must be a non-empty array of check names`);
      }
      if (check.type === "file_hash" && !/^[0-9a-f]{64}$/.test(check.sha256 ?? "")) {
        errors.push(`${at}.sha256 must be 64 lowercase hex characters`);
      }
      if (check.type === "manual" && typeof check.question !== "string") errors.push(`${at}.question is required`);
    }
  }
  if (spec.judges !== undefined &&
      !(Array.isArray(spec.judges) && spec.judges.length > 0 && spec.judges.every(j => typeof j === "string" && j))) {
    errors.push("judges must be a non-empty array of names allowed to resolve manual checks");
  }
  if (Array.isArray(spec.checks) && spec.checks.length) {
    const required = spec.checks.filter(c => c && c.required !== false);
    if (required.length === 0) {
      errors.push("at least one check must be required (otherwise any evidence is an 'achieved' verdict)");
    } else if (required.every(c => c.type === "manual")) {
      // Deterministic anchor: a verdict that rests only on human say-so is not an evaluator, it is a vote.
      errors.push("at least one required check must be machine-verifiable (not manual), so judgment can never be the only gate");
    }
  }
  if (errors.length) throw new Error(`invalid spec:\n- ${errors.join("\n- ")}`);
  return spec;
}

export const specHash = spec => hashJson(validateSpec(spec));
