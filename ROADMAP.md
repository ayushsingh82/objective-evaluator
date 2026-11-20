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
