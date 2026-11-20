import { hashJson } from "./canonical.ts";
import type { CommitteeOptions, CommitteeResult, CommitteeVerdict, Evidence, Review, Spec, Verdict } from "./types.ts";
import { verifyReview } from "./verify.ts";

const FINAL: readonly Verdict[] = ["achieved", "partial", "not_achieved"];

/**
 * M-of-N evaluation: several independent evaluators each sign their own review of the
 * same spec and evidence; the committee verdict is the final verdict at least
 * `threshold` distinct, trusted evaluators agree on. One bribed or broken evaluator
 * cannot decide the outcome alone.
 */
export function verifyCommittee(reviews: Review[], spec: Spec, evidence: Evidence, options: CommitteeOptions): CommitteeResult {
  const { trustedEvaluators, threshold: requested, ...verifyOptions } = options ?? {};
  if (!Array.isArray(trustedEvaluators) || trustedEvaluators.length === 0) {
    throw new Error("a committee needs a non-empty trustedEvaluators list");
  }
  const threshold = requested ?? Math.floor(trustedEvaluators.length / 2) + 1;
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > trustedEvaluators.length) {
    throw new Error("threshold must be between 1 and the number of trusted evaluators");
  }
  if (threshold * 2 <= trustedEvaluators.length) {
    throw new Error("threshold must be a strict majority, or two verdicts could both reach quorum");
  }

  const seen = new Set<string>();
  const rejected: CommitteeResult["rejected"] = [];
  const votes = new Map<Verdict, Array<{ evaluator: string; reviewHash: string }>>();
  for (const review of reviews) {
    const evaluator = review?.body?.evaluator ?? "unknown";
    const result = verifyReview(review, spec, evidence, { ...verifyOptions, trustedEvaluators });
    if (!result.ok) { rejected.push({ evaluator, problems: result.problems }); continue; }
    if (seen.has(evaluator)) { rejected.push({ evaluator, problems: ["duplicate review from the same evaluator"] }); continue; }
    seen.add(evaluator);
    if (!FINAL.includes(review.body.verdict)) { rejected.push({ evaluator, problems: [`verdict ${review.body.verdict} is not a vote`] }); continue; }
    const list = votes.get(review.body.verdict) ?? [];
    list.push({ evaluator, reviewHash: review.reviewHash });
    votes.set(review.body.verdict, list);
  }

  let verdict: CommitteeVerdict = "no_quorum";
  let agreeing: Array<{ evaluator: string; reviewHash: string }> = [];
  for (const [candidate, list] of votes) {
    if (list.length >= threshold) { verdict = candidate; agreeing = list; }
  }
  const commitment = verdict === "no_quorum" ? null : hashJson({
    specHash: hashJson(spec),
    evidenceHash: hashJson(evidence),
    verdict,
    reviewHashes: agreeing.map(a => a.reviewHash).sort(),
  });
  return { ok: verdict !== "no_quorum", verdict, threshold, agreeing: agreeing.map(a => a.evaluator), rejected, commitment };
}
