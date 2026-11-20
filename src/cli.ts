#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { evaluate, generateEvaluatorKey } from "./evaluate.ts";
import { specHash } from "./spec.ts";
import { isFinal, verifyReview } from "./verify.ts";
import { verifyCommittee } from "./committee.ts";
import { toEscrowAction } from "./erc8183.ts";
import type { CommitteeResult, EvaluatorKey, Evidence, FetchLike, HttpResponse, Judgments, Review, Spec } from "./types.ts";
import { errorMessage } from "./util.ts";

const readJson = <T = unknown>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;

interface Args { positional: string[]; flags: Record<string, string | undefined> }

function parseArgs(argv: string[]): Args {
  const out: Args = { positional: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg.startsWith("--")) out.flags[arg.slice(2)] = argv[++i];
    else out.positional.push(arg);
  }
  return out;
}

const need = (flags: Args["flags"], name: string): string => {
  const value = flags[name];
  if (value === undefined) throw new Error(`missing --${name}`);
  return value;
};
const optionalJson = <T>(file: string | undefined): T | undefined => (file ? readJson<T>(file) : undefined);
const optionalNumber = (value: string | undefined): number | undefined => (value !== undefined ? Number(value) : undefined);

const USAGE = `objective-evaluator <command>

  keygen --out key.json                       create an evaluator signing key
  hash-spec <spec.json>                       print the spec hash
  evaluate --spec s.json --evidence e.json --key key.json --out review.json
           [--base-dir dir] [--judgments j.json] [--binding binding.json]
  verify --review review.json --spec s.json --evidence e.json [--trust <pubkeyhex>]
         [--binding binding.json] [--grace <seconds>] [--challenge <seconds>]
  committee --reviews a.json,b.json,c.json --spec s.json --evidence e.json --trust k1,k2,k3 [--threshold 2]
  export-escrow --review review.json | --committee-result result.json   print the complete/reject/hold action
  demo                                        offline end-to-end run with a stubbed network`;

const reply = (o: Partial<HttpResponse>): HttpResponse => ({ ok: true, status: 200, json: async () => ({}), text: async () => "", ...o });

async function demo(): Promise<void> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "examples");
  const spec = readJson<Spec>(path.join(root, "job.spec.json"));
  const key = generateEvaluatorKey();
  const evidence: Evidence = {
    specHash: specHash(spec),
    submittedAt: "2026-12-01T10:00:00Z",
    items: {
      "site-live": { url: "https://example.com" },
      "code-merged": { pr: 23 },
      "ci-green": { sha: "a".repeat(40) },
      "logo-delivered": { path: "logo.txt" },
    },
  };
  const stubFetch: FetchLike = async url => {
    const u = String(url);
    if (u.includes("/check-runs")) {
      return reply({ json: async () => ({ total_count: 1, check_runs: [{ name: "test", status: "completed", conclusion: "success", completed_at: "2026-11-28T08:00:00Z" }] }) });
    }
    if (u.startsWith("https://api.github.com/")) return reply({ json: async () => ({ merged: true, merged_at: "2026-11-28T09:00:00Z" }) });
    return reply({ text: async () => "<h1>Example Domain</h1>" });
  };
  const judgments: Judgments = { "design-quality": { pass: true, by: "city-node.dao", note: "matches brief" } };
  const review = await evaluate(spec, evidence, { privateKey: key.privateKey, fetch: stubFetch, baseDir: path.join(root, "files"), judgments });

  console.log(`verdict:     ${review.body.verdict}`);
  console.log(`reviewHash:  ${review.reviewHash}   <- this is what attest puts on-chain`);
  for (const r of review.body.results) console.log(`  ${r.status.padEnd(15)} ${r.id}: ${r.detail}`);
  console.log("verify (honest):  ", JSON.stringify(verifyReview(review, spec, evidence, { trustedEvaluators: [key.publicKey] })));

  const swapped: Spec = { ...spec, deadline: "2027-12-31T00:00:00Z" };
  console.log("verify (spec swapped after the fact):", JSON.stringify(verifyReview(review, swapped, evidence)));
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const { positional, flags } = parseArgs(rest);
  switch (command) {
    case "keygen": {
      const key = generateEvaluatorKey();
      writeFileSync(need(flags, "out"), JSON.stringify(key, null, 2), { mode: 0o600 });
      console.log(`public key: ${key.publicKey}`);
      return;
    }
    case "hash-spec": {
      const file = positional[0];
      if (!file) throw new Error("usage: hash-spec <spec.json>");
      console.log(specHash(readJson(file)));
      return;
    }
    case "evaluate": {
      const key = readJson<EvaluatorKey>(need(flags, "key"));
      const review = await evaluate(readJson<Spec>(need(flags, "spec")), readJson<Evidence>(need(flags, "evidence")), {
        privateKey: key.privateKey,
        baseDir: flags["base-dir"],
        judgments: optionalJson<Judgments>(flags.judgments) ?? {},
        binding: optionalJson(flags.binding),
        githubToken: process.env.GITHUB_TOKEN,
      });
      writeFileSync(need(flags, "out"), JSON.stringify(review, null, 2));
      console.log(`verdict: ${review.body.verdict}\nreviewHash: ${review.reviewHash}`);
      return;
    }
    case "verify": {
      const review = readJson<Review>(need(flags, "review"));
      const result = verifyReview(review, readJson<Spec>(need(flags, "spec")), readJson<Evidence>(need(flags, "evidence")), {
        trustedEvaluators: flags.trust ? [flags.trust] : undefined,
        binding: optionalJson(flags.binding),
        graceSeconds: optionalNumber(flags.grace),
      });
      console.log(result.ok ? "OK: review is consistent, signed and bound to this spec and evidence" : `INVALID:\n- ${result.problems.join("\n- ")}`);
      const challenge = optionalNumber(flags.challenge);
      if (result.ok && challenge !== undefined) {
        console.log(isFinal(review, { challengeSeconds: challenge }) ? "challenge window has passed: final" : "still inside the challenge window: not final");
      }
      process.exitCode = result.ok ? 0 : 1;
      return;
    }
    case "committee": {
      const result = verifyCommittee(need(flags, "reviews").split(",").map(f => readJson<Review>(f)), readJson<Spec>(need(flags, "spec")), readJson<Evidence>(need(flags, "evidence")), {
        trustedEvaluators: need(flags, "trust").split(","),
        threshold: optionalNumber(flags.threshold),
      });
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.ok ? 0 : 1;
      return;
    }
    case "export-escrow": {
      if (flags.review) {
        const review = readJson<Review>(flags.review);
        console.log(JSON.stringify(toEscrowAction(review.body.verdict, review.reviewHash), null, 2));
      } else {
        const result = readJson<CommitteeResult>(need(flags, "committee-result"));
        console.log(JSON.stringify(toEscrowAction(result.verdict, result.commitment ?? "0".repeat(64)), null, 2));
      }
      return;
    }
    case "demo":
      await demo();
      return;
    default:
      console.log(USAGE);
      process.exitCode = command ? 1 : 0;
  }
}

main(process.argv.slice(2)).catch(e => {
  console.error(`error: ${errorMessage(e)}`);
  process.exitCode = 1;
});
