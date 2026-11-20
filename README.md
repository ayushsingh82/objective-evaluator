# objective-evaluator

**Pay for work only after it is verified.** `objective-evaluator` turns a job's *measurable spec* and the contributors' *evidence* into a **signed verdict** whose hash anyone can re-verify, so an escrow or DAO can release funds on a decision it can check instead of one it has to trust.

It is a small TypeScript toolkit with **zero runtime dependencies** (Node 22.18+), built for escrowed objectives such as NEAR Extents-style contracts, where a contract can hold funds and record a hash, but cannot see the real world.

> **Status: MVP.** Offline-tested (24 tests), not audited, not yet run against a real chain or a real objective contract. See [What it does not prove](#what-it-does-not-prove) and [ROADMAP.md](ROADMAP.md).

---

## The problem

An escrowed job has three roles: a sponsor who funds it, a contributor who delivers, and an evaluator who decides. Everything depends on that decision, and today it is often a single party's word:

- completion is **self-attested** by the agent or contributor;
- the evaluator can be **bribed**, can **collude**, or can attest **after the deadline**;
- a verdict signed for one job can be **replayed** on another;
- a spec can be **quietly edited** after the work was judged.

## What this toolkit does

```
 spec (checks + deadline) ──hash──▶ specHash
 evidence { specHash, submittedAt, items }
              │
              ▼
   evaluate ──▶ result per check ──▶ verdict ──▶ review body ──hash──▶ reviewHash ──sign──▶ signature
                                                                         │
                                       the hash an on-chain attest step records
              │
              ▼
   verifyReview(review, spec, evidence)  ──▶  { ok, problems[] }
   verifyCommittee([reviews…], …)        ──▶  M-of-N verdict + commitment
   toEscrowAction(verdict, hash)         ──▶  complete | reject | hold
```

1. **Write a measurable spec.** Checks a machine can run (a live URL, a merged pull request, green CI, a file hash) plus optional human judgments by named judges.
2. **Collect evidence** bound to the spec's hash.
3. **Evaluate.** Each check returns `pass`, `fail` or `needs_judgment`. The verdict is a pure function of the results.
4. **Sign.** The review is canonicalised, hashed and signed with Ed25519.
5. **Verify.** Anyone recomputes the hashes, checks the signature, and re-derives the verdict from the recorded results.

## Features

| Capability | What it gives you |
|---|---|
| **Measurable specs** | Versioned, validated, hashed. Every problem is reported at once. |
| **Machine checks** | `url_up`, `github_pr_merged`, `github_checks_pass`, `file_hash`, plus `manual` for judgment. |
| **Recomputable verdicts** | `achieved`, `partial`, `not_achieved`, `needs_judgment` follow from the results, so a verifier does not have to trust the evaluator's label. |
| **Judge allowlist** | Only judges named in the spec can resolve a `manual` check. |
| **Deterministic anchor** | A spec must contain a required machine check. A human pass can never rescue a failed machine check. |
| **Replay binding** | A review is bound to `{ chainId, objective, nonce }` and fails verification anywhere else. |
| **Deadline and grace** | Late evidence is `not_achieved` without running any check. Late attestations can be refused. |
| **Challenge window** | `isFinal` reports when the dispute period has passed. |
| **Committee (M-of-N)** | A strict majority of trusted, distinct evaluators must agree. Duplicates and unknown keys are ignored. |
| **Escrow export** | Maps a verdict to `complete`, `reject` or `hold` with a `0x` reason, the shape an ERC-8183-style job escrow uses. |
| **Safe fetching** | https only, no credentials, no private hosts, redirects not followed, path and symlink escapes refused. |

## Quick start

```sh
git clone https://github.com/ayushsingh82/objective-evaluator.git
cd objective-evaluator
npm install        # dev dependencies only: typescript and @types/node
npm run typecheck  # strict TypeScript, no emit
npm test           # 24 tests, run directly on the .ts files
npm run demo       # a full run with the network stubbed
npm run build      # emits dist/ (JavaScript + .d.ts) for use as a package
```

Node 22.18 or newer runs the TypeScript sources directly by stripping types, so no build step is needed to try it. `npm run build` produces plain JavaScript and declaration files for consumers.

The demo evaluates a sample job and then tries to verify the same review against a spec that was edited afterwards:

```
verdict:     achieved
reviewHash:  c341799d…dc7acf0a   <- this is what attest puts on-chain
  pass            site-live: status 200
  pass            code-merged: merged 2026-11-28T09:00:00Z
  pass            ci-green: 1 check run(s) succeeded
  pass            logo-delivered: sha256 matches
  pass            design-quality: judged by city-node.dao: matches brief
  needs_judgment  bonus-copy: Is the copy proofread?
verify (honest):   {"ok":true,"problems":[]}
verify (spec swapped after the fact): {"ok":false,"problems":["review is for a different spec","deadline differs from the spec"]}
```

## A spec

```json
{
  "version": 1,
  "title": "Launch the event landing page",
  "deadline": "2026-12-31T00:00:00Z",
  "judges": ["city-node.dao"],
  "checks": [
    { "id": "site-live",      "type": "url_up", "contains": "Example Domain" },
    { "id": "code-merged",    "type": "github_pr_merged", "repo": "MultiAgency/product-board" },
    { "id": "ci-green",       "type": "github_checks_pass", "repo": "MultiAgency/product-board", "names": ["test"] },
    { "id": "logo-delivered", "type": "file_hash", "sha256": "<64 hex characters>" },
    { "id": "design-quality", "type": "manual", "question": "Does the page match the agreed design brief?" },
    { "id": "bonus-copy",     "type": "manual", "question": "Is the copy proofread?", "required": false }
  ]
}
```

| Check | Spec fields | Evidence | Passes when |
|---|---|---|---|
| `url_up` | `contains?` | `{ url }` | an https URL (no private host, no redirects followed) returns 2xx and contains the text, if set |
| `github_pr_merged` | `repo` | `{ pr }` | the pull request is merged and `merged_at` is not after the deadline |
| `github_checks_pass` | `repo`, `names?` | `{ sha }` | every check run on the commit succeeded, the named runs exist, and all finished before the deadline |
| `file_hash` | `sha256` | `{ path }` | the file inside the evidence directory has that SHA-256 (symlinks resolved) |
| `manual` | `question` | none | an allowed judge supplies `{ pass, by, note? }`; until then the verdict is `needs_judgment` |

`required: false` marks a check as informational.

## Command line

```sh
node src/cli.ts keygen --out key.json
node src/cli.ts hash-spec examples/job.spec.json

node src/cli.ts evaluate \
  --spec spec.json --evidence evidence.json --key key.json --out review.json \
  [--base-dir ./files] [--judgments judgments.json] [--binding binding.json]

node src/cli.ts verify \
  --review review.json --spec spec.json --evidence evidence.json \
  [--trust <evaluator public key>] [--binding binding.json] [--grace 3600] [--challenge 600]

node src/cli.ts committee \
  --reviews a.json,b.json,c.json --spec spec.json --evidence evidence.json \
  --trust key1,key2,key3 [--threshold 2]

node src/cli.ts export-escrow --review review.json
```

After `npm run build` the same commands are available as `objective-evaluator <command>` (the `bin` entry). Set `GITHUB_TOKEN` to avoid GitHub's anonymous rate limit. The evidence file looks like this:

```json
{
  "specHash": "<output of hash-spec>",
  "submittedAt": "2026-12-01T10:00:00Z",
  "items": {
    "site-live": { "url": "https://example.com" },
    "code-merged": { "pr": 23 },
    "logo-delivered": { "path": "logo.txt" }
  }
}
```

## Library

```ts
import {
  evaluate, generateEvaluatorKey, specHash, toEscrowAction, verifyCommittee, verifyReview,
  type Evidence, type Spec,
} from "objective-evaluator";

const spec: Spec = { /* see "A spec" above */ } as Spec;
const evidence: Evidence = { specHash: specHash(spec), submittedAt: "2026-12-01T10:00:00Z", items: {} };

const key = generateEvaluatorKey();                     // { publicKey, privateKey }
const review = await evaluate(spec, evidence, {
  privateKey: key.privateKey,
  baseDir: "./files",
  judgments: { "design-quality": { pass: true, by: "city-node.dao" } },
  binding: { chainId: "near-testnet", objective: "job-1.near", nonce: "7" },
});

const check = verifyReview(review, spec, evidence, {
  trustedEvaluators: [key.publicKey],
  binding: { chainId: "near-testnet", objective: "job-1.near", nonce: "7" },
  graceSeconds: 3600,
});
if (check.ok) console.log(toEscrowAction(review.body.verdict, review.reviewHash));
// { action: "complete", reason: "0x…" }
```

## What verification proves

`verifyReview` checks that:

- the review is **bound to this exact spec and this exact evidence** (a spec edited after the fact, or different evidence, fails);
- the hash and the **Ed25519 signature** are valid for the stated evaluator, and optionally one of a trusted list;
- the results cover **exactly the spec's checks, in order**, the late flag matches the dates, and the **verdict follows from the results**;
- optionally, that it is bound to the expected **objective, chain and nonce** and was made within the **grace period**.

## What it does not prove

Read this before relying on it.

- **That the checks ran honestly.** A malicious evaluator can write false results and sign them. Verification proves consistency, not that the live world matched. Re-run the checks, use a committee, or run the evaluator in an attested environment.
- **Who the evaluator should be.** Trust in a key is established outside this tool, for example by a DAO publishing it.
- **That `submittedAt` is true.** It comes from the evidence. A real deployment should take time from the chain.
- **That evidence is genuine or original.** A page can change after the check, and a merged pull request can be copied work. Machine checks cover facts, not quality or authorship.
- **Anything about the contract.** The tool cannot make a contract check the binding it includes.

Known limits: `url_up` blocks private hostnames by name and literal IP only and does **not** defend against DNS rebinding, so run the evaluator without access to internal networks. A committee protects against a minority of bad evaluators, not against a captured trusted set.

The full list of what can and cannot be done is in [ROADMAP.md](ROADMAP.md).

## Types

Everything public is typed in [`src/types.ts`](src/types.ts) and re-exported from the package root. Check types are a discriminated union, so a spec that uses a field the check type does not have fails to compile, and the check runner switch is exhaustive: adding a check type without a runner is a compile error.

```ts
type Check = UrlUpCheck | GithubPrMergedCheck | GithubChecksPassCheck | FileHashCheck | ManualCheck;
type Verdict = "achieved" | "partial" | "not_achieved" | "needs_judgment";
```

The project compiles with `strict`, `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax` and `erasableSyntaxOnly`. Untrusted input (spec JSON, evidence, judgments, remote API responses) is typed as `unknown` or validated at runtime before it is used.

## Project layout

```
objective-evaluator/
├── src/
│   ├── types.ts        public types
│   ├── util.ts         small helpers
│   ├── canonical.ts    deterministic JSON and sha256
│   ├── spec.ts         spec validation (type guard) and specHash
│   ├── checks.ts       check runners and the URL, path and symlink guards
│   ├── evaluate.ts     evaluate(), deriveVerdict(), key helpers
│   ├── verify.ts       verifyReview(), isFinal()
│   ├── committee.ts    M-of-N committee verification
│   ├── erc8183.ts      verdict to complete / reject / hold
│   ├── index.ts        public entry point
│   └── cli.ts          keygen, hash-spec, evaluate, verify, committee, export-escrow, demo
├── test/               24 tests, including the attack cases
├── examples/           a sample job spec and evidence file
├── tsconfig.json       strict type checking (src and test)
├── tsconfig.build.json emits dist/
├── ROADMAP.md          what is done, what is next, what cannot be done
└── LICENSE
```

## Testing

```sh
npm run typecheck && npm test
```

The suite covers a swapped spec, edited evidence, a forged signature, a re-signed review that omits a check, late evidence, path traversal and symlink escape, SSRF targets, replay across objectives, late attestations, the challenge window, committee quorum with duplicate and sybil members, judge allowlists, and CI checks. The network is stubbed, so the tests run offline.

## Not in scope

This project never holds funds or keys for others and does not settle anything. It is not a replacement for the contract or the DAO's judgment, and it does not decide quality with an AI model alone.

## License

[MIT](LICENSE)
