export type Verdict = "achieved" | "partial" | "not_achieved" | "needs_judgment";
export type CommitteeVerdict = Verdict | "no_quorum";
export type CheckStatus = "pass" | "fail" | "needs_judgment";
export type ResultStatus = CheckStatus | "skipped";

interface CheckBase {
  /** Lowercase letters, digits, `_` and `-`; unique within a spec. */
  id: string;
  /** Defaults to true. `false` makes the check informational. */
  required?: boolean;
}

export interface UrlUpCheck extends CheckBase { type: "url_up"; contains?: string }
export interface GithubPrMergedCheck extends CheckBase { type: "github_pr_merged"; repo: string }
export interface GithubChecksPassCheck extends CheckBase { type: "github_checks_pass"; repo: string; names?: string[] }
export interface FileHashCheck extends CheckBase { type: "file_hash"; sha256: string }
export interface ManualCheck extends CheckBase { type: "manual"; question: string }

export type Check = UrlUpCheck | GithubPrMergedCheck | GithubChecksPassCheck | FileHashCheck | ManualCheck;
export type CheckType = Check["type"];

export interface Spec {
  version: 1;
  title: string;
  /** ISO date-time. */
  deadline: string;
  /** If set, only these names may resolve `manual` checks. */
  judges?: string[];
  checks: Check[];
}

export interface Evidence {
  /** Hash of the spec this evidence was submitted against. */
  specHash: string;
  /** ISO date-time. A real deployment should take this from the chain. */
  submittedAt: string;
  /** Per-check inputs, keyed by check id. Shapes are validated by each runner. */
  items: Record<string, unknown>;
}

export interface Judgment { pass: boolean; by: string; note?: string }
export type Judgments = Record<string, Judgment>;

/** Flat context that ties a review to one objective, e.g. `{ chainId, objective, nonce }`. */
export type Binding = Record<string, string | number>;

export interface CheckOutcome { status: CheckStatus; detail: string }
export interface CheckResult {
  id: string;
  type: CheckType;
  required: boolean;
  status: ResultStatus;
  detail: string;
}

export interface ReviewBody {
  version: 1;
  specHash: string;
  evidenceHash: string;
  deadline: string;
  submittedAt: string;
  late: boolean;
  results: CheckResult[];
  judgments: Judgments;
  binding: Binding | null;
  verdict: Verdict;
  evaluatedAt: string;
  /** Hex of the evaluator's SPKI-encoded Ed25519 public key. */
  evaluator: string;
}

export interface Review {
  body: ReviewBody;
  /** sha256 of the canonical review body: the value an on-chain attest step records. */
  reviewHash: string;
  /** Hex Ed25519 signature over `reviewHash`. */
  signature: string;
}

export interface EvaluatorKey { publicKey: string; privateKey: string }

export interface FetchInit {
  redirect?: "manual" | "follow" | "error";
  signal?: AbortSignal;
  headers?: Record<string, string>;
}
export interface HttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- remote JSON is validated by each runner
  text(): Promise<string>;
}
/** The subset of `fetch` the runners use, so tests and callers can inject their own. */
export type FetchLike = (input: string | URL, init?: FetchInit) => Promise<HttpResponse>;

export interface CheckContext {
  fetch: FetchLike;
  baseDir?: string;
  judgments: Judgments;
  judges?: string[];
  githubToken?: string;
  allowHttp?: boolean;
  timeoutMs?: number;
  deadlineMs: number;
}

export interface EvaluateOptions {
  /** PEM (PKCS#8) Ed25519 private key. */
  privateKey: string;
  fetch?: FetchLike;
  baseDir?: string;
  judgments?: Judgments;
  binding?: Binding;
  now?: () => Date;
  githubToken?: string;
  allowHttp?: boolean;
}

export interface VerifyOptions {
  trustedEvaluators?: string[];
  binding?: Binding;
  graceSeconds?: number;
}

export interface VerifyResult { ok: boolean; problems: string[] }

export interface CommitteeOptions extends VerifyOptions {
  /** Required: the set of evaluators allowed to vote. */
  trustedEvaluators: string[];
  /** Defaults to a strict majority of `trustedEvaluators`. */
  threshold?: number;
}

export interface CommitteeResult {
  ok: boolean;
  verdict: CommitteeVerdict;
  threshold: number;
  agreeing: string[];
  rejected: Array<{ evaluator: string; problems: string[] }>;
  commitment: string | null;
}

export interface EscrowAction {
  action: "complete" | "reject" | "hold";
  note?: string;
  /** `0x` + 64 hex characters. */
  reason: string;
}
