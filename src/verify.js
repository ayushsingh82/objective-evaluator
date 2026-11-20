import { createPublicKey, verify } from "node:crypto";
import { hashJson } from "./canonical.js";
import { deriveVerdict } from "./evaluate.js";
import { specHash, validateSpec } from "./spec.js";

/** True once the challenge window after evaluation has passed (a contract should finalize only then). */
export function isFinal(review, { challengeSeconds, now = new Date() }) {
  if (!Number.isFinite(challengeSeconds) || challengeSeconds < 0) throw new Error("challengeSeconds must be a non-negative number");
  return now.getTime() >= Date.parse(review.body.evaluatedAt) + challengeSeconds * 1000;
}

/**
 * Re-checks a review against the spec and evidence it claims to cover.
 * Returns { ok, problems }. It does not re-run the checks (they may depend on
 * the live world); it proves the review is internally consistent, bound to this
 * exact spec and evidence, correctly signed, and that the verdict follows from
 * the recorded results.
 * options.trustedEvaluators: if given, body.evaluator must be one of these.
 * options.binding: if given ({ chainId, objective, nonce }...), the review must have been made for exactly this
 *   binding, so a review for one objective cannot be replayed on another.
 * options.graceSeconds: if given, evaluation must happen no later than deadline + grace (late attestations are refused).
 */
export function verifyReview(review, spec, evidence, options = {}) {
  const problems = [];
  const fail = message => problems.push(message);
  try {
    validateSpec(spec);
    const body = review?.body;
    if (!body) return { ok: false, problems: ["review has no body"] };

    if (hashJson(body) !== review.reviewHash) fail("reviewHash does not match the review body");

    try {
      const key = createPublicKey({ key: Buffer.from(body.evaluator, "hex"), format: "der", type: "spki" });
      if (!verify(null, Buffer.from(String(review.reviewHash), "utf8"), key, Buffer.from(String(review.signature), "hex"))) {
        fail("signature is not valid for this evaluator key");
      }
    } catch {
      fail("evaluator key or signature is malformed");
    }
    if (options.trustedEvaluators && !options.trustedEvaluators.includes(body.evaluator)) {
      fail("evaluator is not in the trusted set");
    }

    if (options.binding !== undefined && hashJson(body.binding ?? null) !== hashJson(options.binding)) {
      fail("review is bound to a different objective, chain or nonce");
    }
    if (options.graceSeconds !== undefined) {
      if (Date.parse(body.evaluatedAt) > Date.parse(spec.deadline) + options.graceSeconds * 1000) {
        fail("review was made after the deadline plus the grace period");
      }
    }

    if (body.specHash !== specHash(spec)) fail("review is for a different spec");
    if (evidence?.specHash !== body.specHash) fail("evidence names a different spec");
    if (body.evidenceHash !== hashJson(evidence)) fail("review is for different evidence");
    if (body.deadline !== spec.deadline) fail("deadline differs from the spec");
    if (body.submittedAt !== evidence?.submittedAt) fail("submittedAt differs from the evidence");

    const late = Date.parse(body.submittedAt) > Date.parse(spec.deadline);
    if (body.late !== late) fail("late flag is inconsistent with submittedAt and deadline");

    const ids = (body.results ?? []).map(r => r.id);
    if (JSON.stringify(ids) !== JSON.stringify(spec.checks.map(c => c.id))) {
      fail("results do not cover exactly the spec's checks in order");
    } else if (body.verdict !== deriveVerdict(spec, body.results, late)) {
      fail("verdict does not follow from the recorded results");
    }
  } catch (e) {
    fail(e.message);
  }
  return { ok: problems.length === 0, problems };
}
