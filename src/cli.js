#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { evaluate, generateEvaluatorKey } from "./evaluate.js";
import { specHash } from "./spec.js";
import { isFinal, verifyReview } from "./verify.js";
import { verifyCommittee } from "./committee.js";
import { toEscrowAction } from "./erc8183.js";

const readJson = file => JSON.parse(readFileSync(file, "utf8"));

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[++i];
    else out._.push(argv[i]);
  }
  return out;
}

const USAGE = `objective-evaluator <command>

  keygen --out key.json                       create an evaluator signing key
  hash-spec <spec.json>                       print the spec hash
  evaluate --spec s.json --evidence e.json --key key.json --out review.json
           [--base-dir dir] [--judgments j.json]
  verify --review review.json --spec s.json --evidence e.json [--trust <pubkeyhex>]
         [--binding binding.json] [--grace <seconds>] [--challenge <seconds>]
  committee --reviews a.json,b.json,c.json --spec s.json --evidence e.json --trust k1,k2,k3 [--threshold 2]
  export-escrow --review review.json | --committee-result result.json   print the complete/reject/hold action
  demo                                        offline end-to-end run with a stubbed network`;

async function demo() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "examples");
  const spec = readJson(path.join(root, "job.spec.json"));
  const key = generateEvaluatorKey();
  const evidence = {
    specHash: specHash(spec),
    submittedAt: "2026-12-01T10:00:00Z",
    items: {
      "site-live": { url: "https://example.com" },
      "code-merged": { pr: 23 },
      "ci-green": { sha: "a".repeat(40) },
      "logo-delivered": { path: "logo.txt" },
    },
  };
  const stubFetch = async url => {
    const u = String(url);
    if (u.includes("/check-runs")) {
      return { ok: true, status: 200, json: async () => ({ total_count: 1, check_runs: [{ name: "test", status: "completed", conclusion: "success", completed_at: "2026-11-28T08:00:00Z" }] }) };
    }
    if (u.startsWith("https://api.github.com/")) {
      return { ok: true, status: 200, json: async () => ({ merged: true, merged_at: "2026-11-28T09:00:00Z" }) };
    }
    return { ok: true, status: 200, text: async () => "<h1>Example Domain</h1>" };
  };
  const judgments = { "design-quality": { pass: true, by: "city-node.dao", note: "matches brief" } };
  const review = await evaluate(spec, evidence, { privateKey: key.privateKey, fetch: stubFetch, baseDir: path.join(root, "files"), judgments });

  console.log(`verdict:     ${review.body.verdict}`);
  console.log(`reviewHash:  ${review.reviewHash}   <- this is what attest puts on-chain`);
  for (const r of review.body.results) console.log(`  ${r.status.padEnd(15)} ${r.id}: ${r.detail}`);
  console.log("verify (honest):  ", JSON.stringify(verifyReview(review, spec, evidence, { trustedEvaluators: [key.publicKey] })));

  const swapped = { ...spec, deadline: "2027-12-31T00:00:00Z" };
  console.log("verify (spec swapped after the fact):", JSON.stringify(verifyReview(review, swapped, evidence)));
}

const [command, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
try {
  if (command === "keygen") {
    const key = generateEvaluatorKey();
    writeFileSync(args.out, JSON.stringify(key, null, 2), { mode: 0o600 });
    console.log(`public key: ${key.publicKey}`);
  } else if (command === "hash-spec") {
    console.log(specHash(readJson(args._[0])));
  } else if (command === "evaluate") {
    const key = readJson(args.key);
    const review = await evaluate(readJson(args.spec), readJson(args.evidence), {
      privateKey: key.privateKey,
      baseDir: args["base-dir"],
      judgments: args.judgments ? readJson(args.judgments) : {},
      binding: args.binding ? readJson(args.binding) : undefined,
      githubToken: process.env.GITHUB_TOKEN,
    });
    writeFileSync(args.out, JSON.stringify(review, null, 2));
    console.log(`verdict: ${review.body.verdict}\nreviewHash: ${review.reviewHash}`);
  } else if (command === "verify") {
    const review = readJson(args.review);
    const result = verifyReview(review, readJson(args.spec), readJson(args.evidence), {
      trustedEvaluators: args.trust ? [args.trust] : undefined,
      binding: args.binding ? readJson(args.binding) : undefined,
      graceSeconds: args.grace !== undefined ? Number(args.grace) : undefined,
    });
    console.log(result.ok ? "OK: review is consistent, signed and bound to this spec and evidence" : `INVALID:\n- ${result.problems.join("\n- ")}`);
    if (result.ok && args.challenge !== undefined) {
      console.log(isFinal(review, { challengeSeconds: Number(args.challenge) }) ? "challenge window has passed: final" : "still inside the challenge window: not final");
    }
    process.exitCode = result.ok ? 0 : 1;
  } else if (command === "committee") {
    const result = verifyCommittee(args.reviews.split(",").map(readJson), readJson(args.spec), readJson(args.evidence), {
      trustedEvaluators: args.trust.split(","),
      threshold: args.threshold !== undefined ? Number(args.threshold) : undefined,
    });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  } else if (command === "export-escrow") {
    if (args.review) {
      const review = readJson(args.review);
      console.log(JSON.stringify(toEscrowAction(review.body.verdict, review.reviewHash), null, 2));
    } else {
      const result = readJson(args["committee-result"]);
      console.log(JSON.stringify(toEscrowAction(result.verdict, result.commitment ?? "0".repeat(64)), null, 2));
    }
  } else if (command === "demo") {
    await demo();
  } else {
    console.log(USAGE);
    process.exitCode = command ? 1 : 0;
  }
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exitCode = 1;
}
