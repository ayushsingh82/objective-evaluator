# Roadmap: what can be done, and what cannot

Status of `objective-evaluator` v0.1: an offline-tested MVP. It has not been audited, has not been run against a real chain, and has not been matched to a real objective contract's `attest` interface. This file separates three things: what exists, what is worth building next, and what no amount of work in this repo can deliver.

## 1. Done (v0.1)

| Area | What exists |
|---|---|
| Spec and evidence | Versioned spec, canonical JSON hashing, evidence bound to a `specHash` |
| Checks | `url_up`, `github_pr_merged`, `github_checks_pass`, `file_hash`, `manual` |
| Verdict | Pure function of required results (`achieved`, `partial`, `not_achieved`, `needs_judgment`); `verify` recomputes it |
| Signing | Ed25519 over the review hash |
| Hardening | judge allowlist, machine-check anchor, replay binding, grace period, challenge window, M-of-N committee |
| Interop | `complete` / `reject` / `hold` export in the shape of an ERC-8183-style escrow |
| Tests | 24 tests, including swapped spec, forged signature, late evidence, path and symlink escape, SSRF, duplicate and sybil committee members |

## 2. Can be done next

Ordered by value for the effort. Each item names the gap it closes.

### P1: close known gaps in the current design

1. **Match the real `attest` interface.** Gap: the hash format here is my own choice. Needs the objective contract's actual `attest` signature and how it stores the hash. Blocked on seeing that code or its spec (`product-board` #23).
2. **On-chain time instead of claimed time.** Gap: `submittedAt` comes from the submitter. Read the block timestamp of the commit or submission from the chain and use that.
3. **Bind evidence contents, not only paths.** Gap: `file_hash` evidence hashes the path, not the file bytes. Include the content hash in the evidence record so a changed file under the same path is visible.
4. **Key management.** Gap: the private key lives in a JSON file. Support key files with a passphrase or an external signer (hardware key, KMS, or a NEAR account key), and key rotation with an on-record list of past keys.
5. **Spec versioning and migration.** Gap: only `version: 1` exists. Define how a spec upgrade changes hashes and how old reviews stay verifiable.

### P2: stronger evidence

6. **GitHub artifact attestations.** Verify build provenance (which commit, which workflow produced an artifact) instead of trusting a green check name.
7. **zkTLS / TLSNotary proofs for `url_up`.** Contributors supply a proof of what a page served at time T, so the evaluator no longer fetches the live page and the result does not change later.
8. **Content checks that cannot be gamed by text alone.** Examples: run the contributor's tests in a clean sandbox against the spec's own tests; compare a deployed page against a screenshot hash; verify a signed attendance list for an event objective.
9. **Chain evidence.** Checks for "this transfer happened", "this DAO proposal passed", "this contract is deployed with this code hash", read from NEAR RPC or an indexer.

### P3: trust in the evaluator itself

10. **TEE-attested evaluator runs.** Run `evaluate` inside an attested enclave and attach a receipt, following the `private-ai` pattern. Closes "the evaluator might sign false results". Also needs: pin the evaluator's build (reproducible build, recorded measurement), and a reference-value list so a verifier checks for the audited image, not just any genuine enclave.
11. **Re-execution by anyone.** Publish enough data that a third party can re-run the deterministic checks and compare. Closes honesty gaps without hardware trust, for checks that do not depend on live state.
12. **Evaluator transparency log.** An append-only record of every review hash an evaluator ever signed, so it cannot show different verdicts to different parties.

### P4: process and economics

13. **Bonded disputes.** Anyone can challenge a review inside the challenge window by posting a bond; escalation goes to a named court (the DAO or a committee). Follows the optimistic-oracle pattern. The tool can define the data format; the bond and slashing logic belong in the contract.
14. **Committee governance.** Rotation, joining and leaving, and what happens when members disagree for a long time. This repo only verifies a given trusted set.
15. **Milestone objectives.** Make `partial` useful by splitting a job into sub-objectives with their own specs and a parent that depends on them (this matches the Extents composition idea). Needs a spec for parent and child linkage and the "child ends before parent" rule.
16. **Reputation records.** Per-evaluator and per-contributor history of verdicts, disputes and outcomes, as an input to who is trusted. Beware of gaming; start with read-only reporting.

### P5: product surface

17. **Spec authoring helper.** Turn a plain-language job description into a draft spec with measurable checks, and flag vague criteria. An LLM may draft; a human approves the final spec. The draft must never be the evaluator.
18. **Web verifier page.** Drop in a review, spec and evidence and see the verification result in the browser, like `private-ai`'s receipt checker.
19. **NEAR-native packaging.** A contract-side verifier (Rust) for the signature and hash, so the chain checks the evaluator's signature itself instead of trusting a relayer.
20. **A judge assistant, advisory only.** An LLM that reads the evidence and writes notes for the human judge. Rule: it may add context or raise a concern; it can never turn a failed machine check into a pass, and its output is not signed as a verdict.

## 3. Cannot be done (here, or at all)

Be direct about these; they should not be promised in a pitch.

| Limit | Why |
|---|---|
| **Prove the real world to a contract.** | A contract cannot see an event, a design or a quality bar. Evidence is always someone's claim plus a check. The tool shrinks the trust, it never removes it. |
| **Make subjective quality objective.** | "Matches the design brief" needs a person. `manual` exists for this, with an allowlist, a named judge and an on-record note. |
| **Stop a captured trusted set.** | Committee and allowlists assume honest-majority trusted parties. If most of them are bought or collude, the tool will faithfully record the wrong verdict. Governance, not code, fixes this. |
| **Stop bribery completely.** | It can raise the cost (M-of-N, bonds, a public record) but cannot make bribery impossible. Off-chain side payments are invisible to the chain. |
| **Prove a deliverable was not copied.** | A merged PR, a file hash or a live page can all be someone else's work. Provenance checks can reduce this; they cannot settle authorship. |
| **Guarantee a live URL stays as checked.** | A page can change right after the check. Only a proof of the content at a time (zkTLS) or a pinned copy helps, and only for that moment. |
| **Defend against DNS rebinding from inside this tool.** | `url_up` blocks private hostnames by name and literal IP only. Run the evaluator without internal network access, or fetch through a proxy that resolves and pins the address. |
| **Replace an audit.** | 24 tests are not a security review. Before any real funds, the code needs an independent review, and the contract that consumes it needs its own. |
| **Hide data on-chain.** | Review hashes are public. Confidential specs or evidence would need encryption or a TEE, and then the verifier sees less. |
| **Enforce binding on the contract's behalf.** | The tool can include a chain, objective and nonce in the review. It cannot make a contract check them. |
| **Hardware-level guarantees.** | A TEE receipt shows the evaluator ran inside an enclave, not that the enclave is immune to physical attacks (for example the DDR5 interposer research) or to bugs in the software inside it. State the assurance level on every receipt. |

## 4. Open questions to answer with the maintainers

1. What exactly does the objective contract's `attest` take (hash only, or hash plus verdict)? Does it store the evaluator key, or can any key attest?
2. Who is the evaluator set for a first objective, and is it one DAO or a committee?
3. Is `partial` a real outcome for them, or should every objective be binary with milestones for splitting?
4. What is the challenge window and expiry grace they intend, and who can dispute?
5. Where should the evaluator run: a laptop, a CI job, an attested enclave?
6. Is there already an evaluation or acceptance format in Desk (`signed job terms`) that this spec should match instead of inventing a new one?

## 5. Suggested order of work

1. Get answers to questions 1 to 3, then do P1 items 1 and 2.
2. P2 item 6 (GitHub attestations): small, deterministic, high value.
3. P3 item 10 (TEE-attested run): the strongest story, builds on their `private-ai`.
4. P4 item 15 (milestones): makes `partial` real and fits their composition design.
5. Everything else on demand.

## 6. Non-goals

- Moving funds, holding keys for others, or settling anything.
- Replacing the contract or the DAO's judgment.
- Deciding quality with an AI model alone.
- Becoming a general oracle network.

## 7. More improvements (round two)

Additions beyond section 2. Each names the gap it closes. Items in 7.1 are small and should come first.

### 7.1 Repo hygiene and release (do first, cheap)

1. **CI.** There is no CI yet. Add a GitHub Actions workflow that runs `npm ci`, `npm run typecheck`, `npm test` and `npm run build` on every push and pull request, on Node 22 and the current LTS. Gap: nothing stops a broken commit from landing.
2. **SECURITY.md.** How to report a vulnerability, what is in scope, and the "not audited" statement. Gap: a security tool with no disclosure path.
3. **CONTRIBUTING.md, issue and PR templates, CHANGELOG.md.** Gap: outside contributors cannot tell how to help or what changed.
4. **Dependabot and CodeQL.** Gap: dev dependencies and code patterns are not watched.
5. **Tagged release and npm publish with provenance.** Publish `v0.1.0` from CI with npm provenance, so a consumer can check which commit built the package. Gap: today the only install path is cloning.

### 7.2 Formats and interoperability

6. **Published test vectors.** A `vectors/` folder of JSON files (spec, evidence, expected `specHash`, `reviewHash`, verdict, and bad cases that must fail), so a second implementation in Rust or AssemblyScript can prove it agrees. Gap: the hash format exists only as this code.
7. **Check canonical JSON against RFC 8785 (JCS).** The current canonicalization sorts keys by UTF-16 code unit and uses `JSON.stringify` for strings and numbers, which should match JCS for ordinary data. Run the RFC's test vectors and document any difference (for example lone surrogates). Gap: a hash another language cannot reproduce is useless on-chain.
8. **NEAR-native keys and signing.** Today the evaluator key is a raw Ed25519 key in SPKI hex. Add the `ed25519:<base58>` public key format and a NEP-413-style signed message, and verify that the signer is an access key of a named NEAR account. Gap: the evaluator is not yet tied to an account people can recognise.
9. **A written format spec.** One document (`docs/format.md`) defining the spec, evidence, review body, hashing and signature, with a sequence diagram. This also answers `product-board` #23 ("write the spec for review"). Gap: reviewers must read code to learn the format.
10. **Bundle export.** `export-bundle` writes one folder with the spec, evidence, review and the recorded raw responses, plus a manifest of hashes, so a third party can verify offline.

### 7.3 Evidence integrity

11. **Signed evidence.** Contributors sign their evidence submission with their own key, so the review shows who submitted what, and nobody can submit evidence in someone else's name. Gap: evidence has no author.
12. **Record what the evaluator saw.** Store a digest of each remote response (the GitHub JSON, the page body) in the review. A later dispute can then compare against what was actually fetched. Gap: a result that depended on a live fetch cannot be audited afterwards.
13. **Pagination and size limits.** `github_checks_pass` fails closed above 100 check runs; add pagination with a cap. Add response-size limits and a per-run time budget for every network check. Gap: large repos fail and hostile servers can stall a run.
14. **Rate-limit and retry behaviour.** Back off on GitHub rate limits, distinguish "could not check" from "failed", and never turn a network error into a silent pass. Gap: today an outage looks like a failed check.

### 7.4 A richer spec language

15. **Weights and thresholds.** Let a spec say "at least 3 of these 4 checks" or give checks weights, and compute a **payout ratio** deterministically from the results. Export it as `releaseBps` for an escrow that supports partial release. Gap: `partial` currently maps to a refusal.
16. **Spec templates.** Reusable specs for common jobs (landing page, event, code delivery, audit report) with the checks pre-filled. Gap: writing a measurable spec from nothing is the hard part for sponsors.
17. **Spec linting.** Warn on vague manual questions, a deadline in the past, a single point of failure (one URL, one judge), or checks that any contributor can trivially fake. Gap: bad specs make good tooling look bad.
18. **Check plugins.** A typed registry so new check types can be added without editing core files, with each plugin declaring its network and file access. Gap: every new check today means a core change.

### 7.5 More checks

Ordered by usefulness for NEAR objectives:

19. `near_tx_exists`: a transfer or call happened (hash, account, amount, before the deadline).
20. `dao_proposal_passed`: a Sputnik DAO proposal reached `Approved`.
21. `contract_code_hash`: a deployed contract has a given code hash.
22. `http_json`: assert fields in a JSON endpoint (a restricted path syntax, no code execution).
23. `commit_signed_by`: a commit or tag is signed by an expected key.
24. `npm_or_registry_published`: a package version exists with the expected digest.
25. `content_hash_of_url`: a pinned file at a URL matches a hash (for a delivered report or design).

### 7.6 Testing and assurance

26. **Property-based tests.** Random specs and evidence checking that `verify` accepts every honest review and rejects every single-field mutation. Gap: the current tests are examples, not a search.
27. **Fuzzing the parsers.** `validateSpec`, `canonicalize` and the CLI argument handling with malformed input. Gap: untrusted JSON enters here.
28. **Mutation testing.** Confirm the tests fail when the logic is broken (for example when a comparison is flipped). Gap: 24 passing tests do not prove they would catch a regression.
29. **An adversarial deliverable corpus.** A growing set of fake deliverables (weakened tests, copied repos, hollow pages, merged-then-reverted PRs) with a score for which ones the evaluator catches and misses. Publish the misses. Gap: nobody measures how gameable the checks are.
30. **Differential implementation.** A small second verifier (Rust, since the contract side will likely be Rust) tested against the same vectors. Gap: one implementation can share its own blind spots.
31. **Independent review.** A written threat model (STRIDE-style) in `docs/threat-model.md`, then an outside code review, before anything is used with real funds.

### 7.7 Operations

32. **A long-running evaluator service.** A small HTTP service that takes a job id, runs the evaluation on a schedule, and posts the result, with structured logs and a health endpoint. Gap: today a person runs the CLI by hand.
33. **Key rotation and revocation records.** A published list of past and revoked evaluator keys, and a rule for how long old reviews stay valid. Gap: a leaked key has no recovery path.
34. **Idempotent re-evaluation.** Re-running an evaluation must give the same verdict for the same recorded observations, and any difference must be reported. Gap: flaky checks can flip a verdict between runs.

### 7.8 Honest limits for this round

- Weights and payout ratios (15) move trust into the spec: a badly weighted spec pays the wrong amount. They need review like any contract term.
- Signed evidence (11) proves who submitted, not that the content is true or original.
- Recording response digests (12) helps a dispute, but a live page may have changed by the time anyone looks.
- Adding many checks (19 to 25) raises the attack surface. Each new check needs its own tests and its own SSRF and size review before it ships.
- None of 7.1 to 7.7 turns an MVP into something safe for real funds. Item 31 is the gate.
