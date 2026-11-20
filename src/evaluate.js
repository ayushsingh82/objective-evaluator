import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { hashJson } from "./canonical.js";
import { RUNNERS } from "./checks.js";
import { specHash, validateSpec } from "./spec.js";

export function generateEvaluatorKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("hex"),
    privateKey: privateKey.export({ format: "pem", type: "pkcs8" }),
  };
}

export const publicKeyOf = privateKeyPem =>
  createPublicKey(createPrivateKey(privateKeyPem)).export({ format: "der", type: "spki" }).toString("hex");

/**
 * Verdict is a pure function of the spec's required checks and the results, so a
 * verifier can recompute it instead of trusting the evaluator's word.
 */
export function deriveVerdict(spec, results, late) {
  if (late) return "not_achieved";
  const required = new Set(spec.checks.filter(c => c.required !== false).map(c => c.id));
  const mine = results.filter(r => required.has(r.id));
  if (mine.some(r => r.status === "fail")) return mine.some(r => r.status === "pass") ? "partial" : "not_achieved";
  if (mine.some(r => r.status === "needs_judgment")) return "needs_judgment";
  return "achieved";
}

/**
 * evidence: { specHash, submittedAt, items: { [checkId]: {...} } }
 * options:  { privateKey (PEM), fetch, baseDir, judgments, now, githubToken, allowHttp }
 * Returns   { body, reviewHash, signature }. reviewHash is what goes on-chain.
 */
export async function evaluate(spec, evidence, options) {
  validateSpec(spec);
  const { privateKey, fetch: fetchImpl = globalThis.fetch, now = () => new Date() } = options ?? {};
  if (!privateKey) throw new Error("a privateKey is required to sign the review");

  const sHash = specHash(spec);
  if (evidence?.specHash !== sHash) {
    throw new Error("evidence was submitted against a different spec (specHash mismatch)");
  }
  const submittedMs = Date.parse(evidence.submittedAt);
  if (Number.isNaN(submittedMs)) throw new Error("evidence.submittedAt must be an ISO date-time string");
  const deadlineMs = Date.parse(spec.deadline);
  const late = submittedMs > deadlineMs;

  const ctx = {
    fetch: fetchImpl,
    baseDir: options.baseDir,
    judgments: options.judgments ?? {},
    judges: spec.judges,
    githubToken: options.githubToken,
    allowHttp: options.allowHttp,
    deadlineMs,
  };

  const binding = options.binding ?? null;
  if (binding !== null && !(binding && typeof binding === "object" && Object.values(binding).every(v => typeof v === "string" || typeof v === "number"))) {
    throw new Error("binding must be a flat object of strings and numbers, e.g. { chainId, objective, nonce }");
  }

  const results = [];
  for (const check of spec.checks) {
    const base = { id: check.id, type: check.type, required: check.required !== false };
    if (late) { results.push({ ...base, status: "skipped", detail: "evidence submitted after the deadline" }); continue; }
    const out = await RUNNERS[check.type](check, evidence.items?.[check.id], ctx);
    results.push({ ...base, ...out });
  }

  const body = {
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
