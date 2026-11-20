import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { hashJson } from "./canonical.ts";
import { runCheck } from "./checks.ts";
import { specHash, validateSpec } from "./spec.ts";
import type { CheckContext, CheckResult, EvaluateOptions, EvaluatorKey, Evidence, Review, ReviewBody, Spec, Verdict } from "./types.ts";

export function generateEvaluatorKey(): EvaluatorKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("hex"),
    privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  };
}

export const publicKeyOf = (privateKeyPem: string): string =>
  createPublicKey(createPrivateKey(privateKeyPem)).export({ format: "der", type: "spki" }).toString("hex");

/**
 * Verdict is a pure function of the spec's required checks and the results, so a
 * verifier can recompute it instead of trusting the evaluator's word.
 */
export function deriveVerdict(spec: Spec, results: CheckResult[], late: boolean): Verdict {
  if (late) return "not_achieved";
  const required = new Set(spec.checks.filter(c => c.required !== false).map(c => c.id));
  const mine = results.filter(r => required.has(r.id));
  if (mine.some(r => r.status === "fail")) return mine.some(r => r.status === "pass") ? "partial" : "not_achieved";
  if (mine.some(r => r.status === "needs_judgment")) return "needs_judgment";
  return "achieved";
}

/**
 * Runs every check and signs the review. `reviewHash` is what goes on-chain.
 * Evidence is `{ specHash, submittedAt, items: { [checkId]: {...} } }`.
 */
export async function evaluate(spec: Spec, evidence: Evidence, options: EvaluateOptions): Promise<Review> {
  validateSpec(spec);
  const { privateKey, fetch: fetchImpl = globalThis.fetch as unknown as CheckContext["fetch"], now = () => new Date() } = options ?? {};
  if (!privateKey) throw new Error("a privateKey is required to sign the review");

  const sHash = specHash(spec);
  if (evidence?.specHash !== sHash) {
    throw new Error("evidence was submitted against a different spec (specHash mismatch)");
  }
  const submittedMs = Date.parse(evidence.submittedAt);
  if (Number.isNaN(submittedMs)) throw new Error("evidence.submittedAt must be an ISO date-time string");
  const deadlineMs = Date.parse(spec.deadline);
  const late = submittedMs > deadlineMs;

  const ctx: CheckContext = {
    fetch: fetchImpl,
    baseDir: options.baseDir,
    judgments: options.judgments ?? {},
    judges: spec.judges,
    githubToken: options.githubToken,
    allowHttp: options.allowHttp,
    deadlineMs,
  };

  const binding = options.binding ?? null;
  if (binding !== null && !(typeof binding === "object" && Object.values(binding).every(v => typeof v === "string" || typeof v === "number"))) {
    throw new Error("binding must be a flat object of strings and numbers, e.g. { chainId, objective, nonce }");
  }

  const results: CheckResult[] = [];
  for (const check of spec.checks) {
    const base = { id: check.id, type: check.type, required: check.required !== false };
    if (late) { results.push({ ...base, status: "skipped", detail: "evidence submitted after the deadline" }); continue; }
    results.push({ ...base, ...(await runCheck(check, evidence.items?.[check.id], ctx)) });
  }

  const body: ReviewBody = {
    version: 1,
    specHash: sHash,
    evidenceHash: hashJson(evidence),
    deadline: spec.deadline,
    submittedAt: evidence.submittedAt,
    late,
    results,
    judgments: ctx.judgments,
    binding,
    verdict: deriveVerdict(spec, results, late),
    evaluatedAt: now().toISOString(),
    evaluator: publicKeyOf(privateKey),
  };
  const reviewHash = hashJson(body);
  const signature = sign(null, Buffer.from(reviewHash, "utf8"), createPrivateKey(privateKey)).toString("hex");
  return { body, reviewHash, signature };
}
