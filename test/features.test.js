import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { evaluate, generateEvaluatorKey } from "../src/evaluate.js";
import { sha256Hex } from "../src/canonical.js";
import { specHash } from "../src/spec.js";
import { isFinal, verifyReview } from "../src/verify.js";
import { verifyCommittee } from "../src/committee.js";
import { toEscrowAction } from "../src/erc8183.js";

const dir = mkdtempSync(path.join(tmpdir(), "oe2-"));
writeFileSync(path.join(dir, "d.txt"), "ok");
const GOOD = sha256Hex("ok");
const spec = { version: 1, title: "t", deadline: "2026-12-31T00:00:00Z", judges: ["dao"], checks: [
  { id: "file", type: "file_hash", sha256: GOOD },
  { id: "q", type: "manual", question: "ok?" },
] };
const evidence = { specHash: specHash(spec), submittedAt: "2026-12-01T00:00:00Z", items: { file: { path: "d.txt" } } };
const run = (key, extra = {}) => evaluate(spec, evidence, { privateKey: key.privateKey, baseDir: dir, judgments: { q: { pass: true, by: "dao" } }, ...extra });

test("only an allowed judge can resolve a manual check", async () => {
  const key = generateEvaluatorKey();
  assert.equal((await run(key)).body.verdict, "achieved");
  const outsider = await run(key, { judgments: { q: { pass: true, by: "friend-of-the-contributor" } } });
  assert.equal(outsider.body.verdict, "partial"); // machine check passed, the outsider's judgment was refused
  assert.match(outsider.body.results[1].detail, /not an allowed judge/);
});

test("a manual pass can never rescue a failed machine check", async () => {
  const key = generateEvaluatorKey();
  const missing = { ...evidence, items: {} };
  const review = await evaluate(spec, missing, { privateKey: key.privateKey, baseDir: dir, judgments: { q: { pass: true, by: "dao" } } });
  assert.equal(review.body.results[0].status, "fail");
  assert.notEqual(review.body.verdict, "achieved");
});

test("a review bound to one objective cannot be replayed on another", async () => {
  const key = generateEvaluatorKey();
  const binding = { chainId: "near-testnet", objective: "obj-1.near", nonce: "7" };
  const review = await run(key, { binding });
  assert.equal(verifyReview(review, spec, evidence, { binding }).ok, true);
  const other = verifyReview(review, spec, evidence, { binding: { ...binding, objective: "obj-2.near" } });
  assert.equal(other.ok, false);
  assert.match(other.problems.join("\n"), /different objective/);
  const unbound = await run(key);
  assert.equal(verifyReview(unbound, spec, evidence, { binding }).ok, false);
  await assert.rejects(run(key, { binding: { nested: { a: 1 } } }), /flat object/);
});

test("a review made after the deadline plus grace is refused", async () => {
  const key = generateEvaluatorKey();
  const late = await run(key, { now: () => new Date("2027-01-10T00:00:00Z") });
  assert.equal(verifyReview(late, spec, evidence).ok, true);
  const result = verifyReview(late, spec, evidence, { graceSeconds: 3600 });
  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), /grace period/);
  const onTime = await run(key, { now: () => new Date("2026-12-31T00:30:00Z") });
  assert.equal(verifyReview(onTime, spec, evidence, { graceSeconds: 3600 }).ok, true);
});

test("a review is final only after the challenge window", async () => {
  const key = generateEvaluatorKey();
  const review = await run(key, { now: () => new Date("2026-12-02T00:00:00Z") });
  assert.equal(isFinal(review, { challengeSeconds: 600, now: new Date("2026-12-02T00:09:59Z") }), false);
  assert.equal(isFinal(review, { challengeSeconds: 600, now: new Date("2026-12-02T00:10:00Z") }), true);
  assert.throws(() => isFinal(review, { challengeSeconds: -1 }), /non-negative/);
});

test("committee: a strict majority decides, one rogue evaluator cannot", async () => {
  const [a, b, c] = [generateEvaluatorKey(), generateEvaluatorKey(), generateEvaluatorKey()];
  const trusted = [a.publicKey, b.publicKey, c.publicKey];
  const honest = await Promise.all([run(a), run(b)]);
  const rogueSpec = { ...evidence, items: {} };
  const rogue = await evaluate(spec, rogueSpec, { privateKey: c.privateKey, baseDir: dir });
  // The rogue evaluator was handed different evidence, so its review is rejected rather than counted.
  const result = verifyCommittee([...honest, rogue], spec, evidence, { trustedEvaluators: trusted });
  assert.equal(result.verdict, "achieved");
  assert.equal(result.ok, true);
  assert.equal(result.agreeing.length, 2);
  assert.equal(result.rejected.length, 1);
  assert.match(result.commitment, /^[0-9a-f]{64}$/);
});

test("committee: no quorum, duplicates, untrusted keys and weak thresholds", async () => {
  const [a, b, c] = [generateEvaluatorKey(), generateEvaluatorKey(), generateEvaluatorKey()];
  const trusted = [a.publicKey, b.publicKey, c.publicKey];
  const achieved = await run(a);
  const failed = await evaluate(spec, evidence, { privateKey: b.privateKey, baseDir: dir, judgments: { q: { pass: false, by: "dao" } } });
  assert.equal(failed.body.verdict, "partial");
  assert.equal(verifyCommittee([achieved, failed], spec, evidence, { trustedEvaluators: trusted }).verdict, "no_quorum");

  // The same evaluator submitting twice counts once.
  const twice = verifyCommittee([achieved, achieved], spec, evidence, { trustedEvaluators: trusted });
  assert.equal(twice.verdict, "no_quorum");
  assert.match(twice.rejected[0].problems[0], /duplicate/);

  // An evaluator outside the trusted set cannot vote, however many keys it makes.
  const sybils = await Promise.all([generateEvaluatorKey(), generateEvaluatorKey(), generateEvaluatorKey()].map(k => run(k)));
  assert.equal(verifyCommittee(sybils, spec, evidence, { trustedEvaluators: trusted }).verdict, "no_quorum");

  assert.throws(() => verifyCommittee([achieved], spec, evidence, {}), /trustedEvaluators/);
  assert.throws(() => verifyCommittee([achieved], spec, evidence, { trustedEvaluators: trusted, threshold: 1 }), /strict majority/);
  assert.throws(() => verifyCommittee([achieved], spec, evidence, { trustedEvaluators: trusted, threshold: 4 }), /between 1/);
});

test("committee: needs_judgment reviews are not votes", async () => {
  const keys = [generateEvaluatorKey(), generateEvaluatorKey(), generateEvaluatorKey()];
  const pending = await Promise.all(keys.map(k => evaluate(spec, evidence, { privateKey: k.privateKey, baseDir: dir })));
  assert.equal(pending[0].body.verdict, "needs_judgment");
  const result = verifyCommittee(pending, spec, evidence, { trustedEvaluators: keys.map(k => k.publicKey) });
  assert.equal(result.verdict, "no_quorum");
  assert.equal(result.rejected.length, 3);
});

test("escrow mapping: complete, reject, hold, and a bad hash is refused", () => {
  const h = "ab".repeat(32);
  assert.deepEqual(toEscrowAction("achieved", h), { action: "complete", reason: `0x${h}` });
  assert.equal(toEscrowAction("not_achieved", h).action, "reject");
  assert.equal(toEscrowAction("partial", h).action, "reject");
  assert.equal(toEscrowAction("needs_judgment", h).action, "hold");
  assert.equal(toEscrowAction("no_quorum", h).action, "hold");
  assert.throws(() => toEscrowAction("achieved", "nope"), /64 lowercase hex/);
  assert.throws(() => toEscrowAction("maybe", h), /unknown verdict/);
});

test("github_checks_pass needs every run green, named runs present, and in time", async () => {
  const key = generateEvaluatorKey();
  const s = { version: 1, title: "t", deadline: "2026-12-01T00:00:00Z", checks: [{ id: "ci", type: "github_checks_pass", repo: "o/r", names: ["test"] }] };
  const e = { specHash: specHash(s), submittedAt: "2026-11-20T00:00:00Z", items: { ci: { sha: "b".repeat(40) } } };
  const api = runs => async () => ({ ok: true, status: 200, json: async () => ({ total_count: runs.length, check_runs: runs }) });
  const ok = { name: "test", status: "completed", conclusion: "success", completed_at: "2026-11-19T00:00:00Z" };
  const verdict = async runs => (await evaluate(s, e, { privateKey: key.privateKey, fetch: api(runs) })).body.verdict;
  assert.equal(await verdict([ok]), "achieved");
  assert.equal(await verdict([{ ...ok, conclusion: "failure" }]), "not_achieved");
  assert.equal(await verdict([{ ...ok, name: "lint" }]), "not_achieved");
  assert.equal(await verdict([{ ...ok, status: "in_progress" }]), "not_achieved");
  assert.equal(await verdict([{ ...ok, completed_at: "2026-12-02T00:00:00Z" }]), "not_achieved");
  assert.equal(await verdict([]), "not_achieved");
  const badSha = { ...e, items: { ci: { sha: "main" } } };
  assert.equal((await evaluate(s, badSha, { privateKey: key.privateKey, fetch: api([ok]) })).body.verdict, "not_achieved");
});
