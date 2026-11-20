import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { sha256Hex } from "./canonical.ts";
import type {
  Check, CheckContext, CheckOutcome, FileHashCheck, GithubChecksPassCheck, GithubPrMergedCheck, Judgment, ManualCheck, UrlUpCheck,
} from "./types.ts";
import { asRecord, errorMessage } from "./util.ts";

// Each runner returns { status: "pass" | "fail" | "needs_judgment", detail }.
// A runner must never throw for bad evidence: that is a "fail". Only programmer
// errors propagate.

const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|0\.0\.0\.0|127\..*|10\..*|192\.168\..*|169\.254\..*|172\.(1[6-9]|2\d|3[01])\..*|\[?::1\]?|\[?fe80:.*|\[?f[cd][0-9a-f]{2}:.*)$/i;

/** Evaluator-side fetch guard: https only, no obvious private targets. DNS rebinding is NOT covered (see README). */
export function assertPublicHttps(raw: unknown, { allowHttp = false }: { allowHttp?: boolean } = {}): URL {
  let url: URL;
  try { url = new URL(raw as string); } catch { throw new Error("not a valid URL"); }
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) throw new Error("only https URLs are allowed");
  if (url.username || url.password) throw new Error("URLs with credentials are not allowed");
  if (PRIVATE_HOST.test(url.hostname)) throw new Error("private or local hosts are not allowed");
  return url;
}

const timeout = (ctx: CheckContext) => AbortSignal.timeout(ctx.timeoutMs ?? 15_000);
const githubHeaders = (ctx: CheckContext): Record<string, string> => ({
  accept: "application/vnd.github+json",
  ...(ctx.githubToken ? { authorization: `Bearer ${ctx.githubToken}` } : {}),
});
const fail = (detail: string): CheckOutcome => ({ status: "fail", detail });
const pass = (detail: string): CheckOutcome => ({ status: "pass", detail });

async function urlUp(check: UrlUpCheck, evidence: unknown, ctx: CheckContext): Promise<CheckOutcome> {
  let url: URL;
  try { url = assertPublicHttps(asRecord(evidence).url, ctx); } catch (e) { return fail(errorMessage(e)); }
  let res;
  try {
    res = await ctx.fetch(url, { redirect: "manual", signal: timeout(ctx) });
  } catch (e) {
    return fail(`request failed: ${errorMessage(e)}`);
  }
  if (res.status < 200 || res.status >= 300) return fail(`status ${res.status}`);
  if (check.contains !== undefined) {
    const body = (await res.text()).slice(0, 1_000_000);
    if (!body.includes(check.contains)) return fail("expected text not found");
  }
  return pass(`status ${res.status}`);
}

async function githubPrMerged(check: GithubPrMergedCheck, evidence: unknown, ctx: CheckContext): Promise<CheckOutcome> {
  const number = Number(asRecord(evidence).pr);
  if (!Number.isInteger(number) || number <= 0) return fail("evidence.pr must be a positive integer");
  let res;
  try {
    res = await ctx.fetch(`https://api.github.com/repos/${check.repo}/pulls/${number}`, { headers: githubHeaders(ctx), signal: timeout(ctx) });
  } catch (e) {
    return fail(`request failed: ${errorMessage(e)}`);
  }
  if (!res.ok) return fail(`GitHub returned ${res.status}`);
  const pr = (await res.json()) as { merged?: boolean; merged_at?: string | null };
  if (!pr.merged || !pr.merged_at) return fail("pull request is not merged");
  if (Date.parse(pr.merged_at) > ctx.deadlineMs) return fail(`merged ${pr.merged_at}, after the deadline`);
  return pass(`merged ${pr.merged_at}`);
}

async function fileHash(check: FileHashCheck, evidence: unknown, ctx: CheckContext): Promise<CheckOutcome> {
  const filePath = asRecord(evidence).path;
  if (typeof filePath !== "string" || !ctx.baseDir) return fail("evidence.path and a base directory are required");
  const inside = (root: string, p: string) => p === root || p.startsWith(root + path.sep);
  const base = path.resolve(ctx.baseDir);
  const target = path.resolve(base, filePath);
  if (!inside(base, target)) return fail("path escapes the evidence directory");
  let bytes: Buffer;
  try {
    // Resolve symlinks on both sides so a link inside the directory cannot point outside it.
    const [realBase, realTarget] = await Promise.all([realpath(base), realpath(target)]);
    if (!inside(realBase, realTarget)) return fail("path escapes the evidence directory");
    bytes = await readFile(realTarget);
  } catch { return fail("file not readable"); }
  return sha256Hex(bytes) === check.sha256 ? pass("sha256 matches") : fail("sha256 does not match");
}

interface CheckRun { name: string; status: string; conclusion: string | null; completed_at: string | null }

async function githubChecksPass(check: GithubChecksPassCheck, evidence: unknown, ctx: CheckContext): Promise<CheckOutcome> {
  const sha = asRecord(evidence).sha;
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) return fail("evidence.sha must be a 40-character commit sha");
  let res;
  try {
    res = await ctx.fetch(`https://api.github.com/repos/${check.repo}/commits/${sha}/check-runs?per_page=100`, { headers: githubHeaders(ctx), signal: timeout(ctx) });
  } catch (e) {
    return fail(`request failed: ${errorMessage(e)}`);
  }
  if (!res.ok) return fail(`GitHub returned ${res.status}`);
  const { total_count: total, check_runs: runs } = (await res.json()) as { total_count: number; check_runs: CheckRun[] };
  if (!Array.isArray(runs) || runs.length === 0) return fail("no check runs on that commit");
  if (total > runs.length) return fail("too many check runs to verify in one page");
  for (const name of check.names ?? []) {
    if (!runs.some(r => r.name === name)) return fail(`required check "${name}" is missing`);
  }
  const bad = runs.find(r => r.status !== "completed" || r.conclusion !== "success");
  if (bad) return fail(`check "${bad.name}" is ${bad.status === "completed" ? bad.conclusion : bad.status}`);
  const late = runs.find(r => Date.parse(r.completed_at ?? "") > ctx.deadlineMs);
  if (late) return fail(`check "${late.name}" completed after the deadline`);
  return pass(`${runs.length} check run(s) succeeded`);
}

function manual(check: ManualCheck, ctx: CheckContext): CheckOutcome {
  // Judgments arrive as untrusted JSON, so read them as partial and validate.
  const judgment = ctx.judgments[check.id] as Partial<Judgment> | undefined;
  if (!judgment) return { status: "needs_judgment", detail: check.question };
  if (typeof judgment.pass !== "boolean" || typeof judgment.by !== "string") {
    return fail("judgment needs { pass: boolean, by: string }");
  }
  if (ctx.judges && !ctx.judges.includes(judgment.by)) {
    return fail(`${judgment.by} is not an allowed judge for this spec`);
  }
  return { status: judgment.pass ? "pass" : "fail", detail: `judged by ${judgment.by}${judgment.note ? `: ${judgment.note}` : ""}` };
}

/** Runs one check. Exhaustive over the check types: adding a type without a runner fails to compile. */
export async function runCheck(check: Check, evidence: unknown, ctx: CheckContext): Promise<CheckOutcome> {
  switch (check.type) {
    case "url_up": return urlUp(check, evidence, ctx);
    case "github_pr_merged": return githubPrMerged(check, evidence, ctx);
    case "github_checks_pass": return githubChecksPass(check, evidence, ctx);
    case "file_hash": return fileHash(check, evidence, ctx);
    case "manual": return manual(check, ctx);
    default: {
      const unreachable: never = check;
      throw new Error(`unknown check type ${JSON.stringify(unreachable)}`);
    }
  }
}
