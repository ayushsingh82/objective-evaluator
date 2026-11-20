import test from "node:test";
import assert from "node:assert/strict";
import { createPrivateKey, sign } from "node:crypto";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { evaluate, generateEvaluatorKey } from "../src/evaluate.ts";
import { hashJson, sha256Hex } from "../src/canonical.ts";
import { validateSpec } from "../src/spec.ts";
import { verifyReview } from "../src/verify.ts";
import { assertPublicHttps } from "../src/checks.ts";
import type { EvaluateOptions, Evidence, FetchInit, FetchLike, ReviewBody, Spec } from "../src/types.ts";
import { makeEvidence, makeSpec, okFetch, reply } from "./helpers.ts";

const key = generateEvaluatorKey();
const dir = mkdtempSync(path.join(tmpdir(), "oe-"));
writeFileSync(path.join(dir, "deliverable.txt"), "the deliverable");
const DELIVERABLE = sha256Hex("the deliverable");

const run = (spec: Spec, evidence: Evidence, extra: Partial<EvaluateOptions> = {}) =>
  evaluate(spec, evidence, { privateKey: key.privateKey, fetch: okFetch(), baseDir: dir, ...extra });

test("achieved when every required check passes, and the review verifies", async () => {
  const spec = makeSpec([{ id: "file", type: "file_hash", sha256: DELIVERABLE }, { id: "site", type: "url_up", contains: "hello" }]);
  const evidence = makeEvidence(spec, { file: { path: "deliverable.txt" }, site: { url: "https://example.org" } });
  const review = await run(spec, evidence);
  assert.equal(review.body.verdict, "achieved");
  assert.deepEqual(verifyReview(review, spec, evidence, { trustedEvaluators: [key.publicKey] }), { ok: true, problems: [] });
});

test("partial and not_achieved follow from required results; optional checks do not count", async () => {
  const spec = makeSpec([
    { id: "a", type: "file_hash", sha256: DELIVERABLE },
    { id: "b", type: "file_hash", sha256: "0".repeat(64) },
    { id: "opt", type: "file_hash", sha256: "0".repeat(64), required: false },
  ]);
  const evidence = makeEvidence(spec, { a: { path: "deliverable.txt" }, b: { path: "deliverable.txt" }, opt: { path: "deliverable.txt" } });
  assert.equal((await run(spec, evidence)).body.verdict, "partial");
  const none = makeEvidence(spec, {});
  assert.equal((await run(spec, none)).body.verdict, "not_achieved");
});

test("manual checks wait for a judgment instead of passing silently", async () => {
  const spec = makeSpec([{ id: "file", type: "file_hash", sha256: DELIVERABLE }, { id: "q", type: "manual", question: "Good?" }]);
  const evidence = makeEvidence(spec, { file: { path: "deliverable.txt" } });
  assert.equal((await run(spec, evidence)).body.verdict, "needs_judgment");
  const judged = await run(spec, evidence, { judgments: { q: { pass: true, by: "dao" } } });
  assert.equal(judged.body.verdict, "achieved");
  const malformed = await run(spec, evidence, { judgments: { q: { pass: "yes" } as never } });
  assert.equal(malformed.body.verdict, "partial"); // machine check passed, the malformed judgment failed
});

test("spec swapped after the fact is detected", async () => {
  const spec = makeSpec([{ id: "file", type: "file_hash", sha256: DELIVERABLE }]);
  const evidence = makeEvidence(spec, { file: { path: "deliverable.txt" } });
  const review = await run(spec, evidence);
  const weaker = makeSpec([{ id: "file", type: "file_hash", sha256: DELIVERABLE }], "2030-01-01T00:00:00Z");
  const result = verifyReview(review, weaker, evidence);
  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), /different spec/);
});

test("evidence submitted against another spec is refused before any check runs", async () => {
  const spec = makeSpec([{ id: "file", type: "file_hash", sha256: DELIVERABLE }]);
  const other = makeSpec([{ id: "file", type: "file_hash", sha256: "1".repeat(64) }]);
  await assert.rejects(run(spec, makeEvidence(other, {})), /specHash mismatch/);
});

test("tampered evidence, tampered verdict and a forged signature all fail verification", async () => {
  const spec = makeSpec([{ id: "file", type: "file_hash", sha256: "0".repeat(64) }]);
  const evidence = makeEvidence(spec, { file: { path: "deliverable.txt" } });
  const review = await run(spec, evidence);
  assert.equal(review.body.verdict, "not_achieved");

  const editedEvidence: Evidence = { ...evidence, items: { file: { path: "other.txt" } } };
  assert.match(verifyReview(review, spec, editedEvidence).problems.join("\n"), /different evidence/);

  const bumped = structuredClone(review);
  bumped.body.verdict = "achieved";
  const bumpedResult = verifyReview(bumped, spec, evidence);
  assert.equal(bumpedResult.ok, false);
  assert.match(bumpedResult.problems.join("\n"), /reviewHash does not match/);

  // An attacker who recomputes the hash still cannot sign as the evaluator.
  const attacker = generateEvaluatorKey();
  const forged = await evaluate(spec, evidence, { privateKey: attacker.privateKey, fetch: okFetch(), baseDir: dir });
  forged.body.evaluator = key.publicKey;
  const forgedResult = verifyReview(forged, spec, evidence, { trustedEvaluators: [key.publicKey] });
  assert.equal(forgedResult.ok, false);

  // A genuine but untrusted evaluator is rejected when a trust list is given.
  assert.match(verifyReview(forged, spec, evidence, { trustedEvaluators: ["00"] }).problems.join("\n"), /not in the trusted set/);
});

test("late evidence is not_achieved and no checks run", async () => {
  let called = false;
  const spec = makeSpec([{ id: "site", type: "url_up" }], "2026-12-01T00:00:00Z");
  const evidence = makeEvidence(spec, { site: { url: "https://example.org" } }, "2026-12-02T00:00:00Z");
  const review = await run(spec, evidence, { fetch: async () => { called = true; return reply(); } });
  assert.equal(review.body.verdict, "not_achieved");
  assert.equal(review.body.late, true);
  assert.equal(called, false);
  assert.equal(verifyReview(review, spec, evidence).ok, true);

  // Lying about lateness is caught.
  const lie = structuredClone(review);
  lie.body.late = false;
  assert.equal(verifyReview(lie, spec, evidence).ok, false);
});

test("file_hash refuses path traversal and absolute paths", async () => {
  const spec = makeSpec([{ id: "file", type: "file_hash", sha256: DELIVERABLE }]);
  const evidence = makeEvidence(spec, { file: { path: "../../../etc/passwd" } });
  const review = await run(spec, evidence);
  assert.equal(review.body.results[0]?.status, "fail");
  assert.match(review.body.results[0]?.detail ?? "", /escapes/);
  const abs = makeEvidence(spec, { file: { path: "/etc/passwd" } });
  assert.match((await run(spec, abs)).body.results[0]?.detail ?? "", /escapes/);
});

test("file_hash refuses a symlink that points outside the evidence directory", async () => {
  const outside = mkdtempSync(path.join(tmpdir(), "oe-outside-"));
  writeFileSync(path.join(outside, "secret.txt"), "the deliverable");
  symlinkSync(path.join(outside, "secret.txt"), path.join(dir, "link.txt"));
  const spec = makeSpec([{ id: "file", type: "file_hash", sha256: DELIVERABLE }]);
  const review = await run(spec, makeEvidence(spec, { file: { path: "link.txt" } }));
  assert.equal(review.body.results[0]?.status, "fail");
  assert.match(review.body.results[0]?.detail ?? "", /escapes/);
});

test("url_up blocks private hosts, credentials and plain http", () => {
  for (const url of ["http://example.org", "https://localhost/x", "https://127.0.0.1/", "https://10.0.0.5/", "https://169.254.169.254/latest", "https://user:pw@example.org/", "file:///etc/passwd", "https://[::1]/"]) {
    assert.throws(() => assertPublicHttps(url), Error, url);
  }
  assert.doesNotThrow(() => assertPublicHttps("https://example.org/path"));
});

test("url_up never follows redirects and fails on non-2xx", async () => {
  const spec = makeSpec([{ id: "site", type: "url_up" }]);
  const evidence = makeEvidence(spec, { site: { url: "https://example.org" } });
  let seen = undefined as FetchInit | undefined;
  const fetchStub: FetchLike = async (_url, init) => { seen = init; return reply({ ok: false, status: 302 }); };
  const review = await run(spec, evidence, { fetch: fetchStub });
  assert.equal(seen?.redirect, "manual");
  assert.equal(review.body.results[0]?.status, "fail");
});

test("github_pr_merged requires a merge before the deadline", async () => {
  const spec = makeSpec([{ id: "pr", type: "github_pr_merged", repo: "o/r" }], "2026-12-01T00:00:00Z");
  const evidence = makeEvidence(spec, { pr: { pr: 5 } });
  const pr = (mergedAt: string | null): FetchLike => async () => reply({ json: async () => ({ merged: Boolean(mergedAt), merged_at: mergedAt }) });
  assert.equal((await run(spec, evidence, { fetch: pr("2026-11-30T00:00:00Z") })).body.verdict, "achieved");
  assert.equal((await run(spec, evidence, { fetch: pr("2026-12-02T00:00:00Z") })).body.verdict, "not_achieved");
  assert.equal((await run(spec, evidence, { fetch: pr(null) })).body.verdict, "not_achieved");
  const bad = makeEvidence(spec, { pr: { pr: "1; drop" } });
  assert.equal((await run(spec, bad)).body.verdict, "not_achieved");
});

test("spec validation reports every problem and needs one required check", () => {
  assert.throws(() => validateSpec({ version: 2, checks: [] }), /version must be 1[\s\S]*title[\s\S]*deadline[\s\S]*non-empty/);
  assert.throws(() => validateSpec(makeSpec([{ id: "x", type: "manual", question: "q", required: false }])), /at least one check must be required/);
  assert.throws(() => validateSpec(makeSpec([{ id: "x", type: "manual", question: "q" }])), /machine-verifiable/);
  assert.throws(() => validateSpec(makeSpec([{ id: "x", type: "manual", question: "q" }, { id: "x", type: "manual", question: "q" }])), /duplicated/);
  assert.throws(() => validateSpec({ ...makeSpec([{ id: "f", type: "file_hash", sha256: "0".repeat(64) }]), judges: [] }), /judges must be/);
});

test("results that do not match the spec's checks are rejected by the verifier", async () => {
  const spec = makeSpec([{ id: "file", type: "file_hash", sha256: DELIVERABLE }, { id: "q", type: "manual", question: "ok?" }]);
  const evidence = makeEvidence(spec, { file: { path: "deliverable.txt" } });
  const review = await run(spec, evidence);
  assert.equal(review.body.verdict, "needs_judgment");
  // Drop the unresolved check and re-sign with the real key: must still fail.
  const trimmed: ReviewBody = { ...review.body, results: review.body.results.filter(r => r.id === "file"), verdict: "achieved" };
  const reviewHash = hashJson(trimmed);
  const signature = sign(null, Buffer.from(reviewHash, "utf8"), createPrivateKey(key.privateKey)).toString("hex");
  const result = verifyReview({ body: trimmed, reviewHash, signature }, spec, evidence);
  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), /cover exactly/);
});
