import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { sha256Hex } from "./canonical.js";

// Each runner returns { status: "pass" | "fail" | "needs_judgment", detail }.
// A runner must never throw for bad evidence: that is a "fail". Only programmer
// errors propagate.

const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|0\.0\.0\.0|127\..*|10\..*|192\.168\..*|169\.254\..*|172\.(1[6-9]|2\d|3[01])\..*|\[?::1\]?|\[?fe80:.*|\[?f[cd][0-9a-f]{2}:.*)$/i;

/** Evaluator-side fetch guard: https only, no obvious private targets. DNS rebinding is NOT covered (see README). */
export function assertPublicHttps(raw, { allowHttp = false } = {}) {
  let url;
  try { url = new URL(raw); } catch { throw new Error("not a valid URL"); }
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) throw new Error("only https URLs are allowed");
  if (url.username || url.password) throw new Error("URLs with credentials are not allowed");
  if (PRIVATE_HOST.test(url.hostname)) throw new Error("private or local hosts are not allowed");
  return url;
}

async function urlUp(check, evidence, ctx) {
  let url;
  try { url = assertPublicHttps(evidence?.url, ctx); } catch (e) { return { status: "fail", detail: e.message }; }
  let res;
  try {
    res = await ctx.fetch(url, { redirect: "manual", signal: AbortSignal.timeout(ctx.timeoutMs ?? 15_000) });
  } catch (e) {
    return { status: "fail", detail: `request failed: ${e.message}` };
  }
  if (res.status < 200 || res.status >= 300) return { status: "fail", detail: `status ${res.status}` };
  if (check.contains !== undefined) {
    const body = (await res.text()).slice(0, 1_000_000);
    if (!body.includes(check.contains)) return { status: "fail", detail: "expected text not found" };
  }
  return { status: "pass", detail: `status ${res.status}` };
}

async function githubPrMerged(check, evidence, ctx) {
  const number = Number(evidence?.pr);
  if (!Number.isInteger(number) || number <= 0) return { status: "fail", detail: "evidence.pr must be a positive integer" };
  let res;
  try {
    res = await ctx.fetch(`https://api.github.com/repos/${check.repo}/pulls/${number}`, {
      headers: { accept: "application/vnd.github+json", ...(ctx.githubToken ? { authorization: `Bearer ${ctx.githubToken}` } : {}) },
      signal: AbortSignal.timeout(ctx.timeoutMs ?? 15_000),
    });
  } catch (e) {
    return { status: "fail", detail: `request failed: ${e.message}` };
  }
  if (!res.ok) return { status: "fail", detail: `GitHub returned ${res.status}` };
  const pr = await res.json();
  if (!pr.merged || !pr.merged_at) return { status: "fail", detail: "pull request is not merged" };
  if (Date.parse(pr.merged_at) > ctx.deadlineMs) return { status: "fail", detail: `merged ${pr.merged_at}, after the deadline` };
  return { status: "pass", detail: `merged ${pr.merged_at}` };
}

async function fileHash(check, evidence, ctx) {
  if (typeof evidence?.path !== "string" || !ctx.baseDir) return { status: "fail", detail: "evidence.path and a base directory are required" };
  const inside = (root, p) => p === root || p.startsWith(root + path.sep);
  const base = path.resolve(ctx.baseDir);
  const target = path.resolve(base, evidence.path);
  if (!inside(base, target)) return { status: "fail", detail: "path escapes the evidence directory" };
  let bytes;
  try {
    // Resolve symlinks on both sides so a link inside the directory cannot point outside it.
    const [realBase, realTarget] = await Promise.all([realpath(base), realpath(target)]);
    if (!inside(realBase, realTarget)) return { status: "fail", detail: "path escapes the evidence directory" };
    bytes = await readFile(realTarget);
  } catch { return { status: "fail", detail: "file not readable" }; }
  return sha256Hex(bytes) === check.sha256
    ? { status: "pass", detail: "sha256 matches" }
    : { status: "fail", detail: "sha256 does not match" };
}

async function githubChecksPass(check, evidence, ctx) {
  if (!/^[0-9a-f]{40}$/.test(evidence?.sha ?? "")) return { status: "fail", detail: "evidence.sha must be a 40-character commit sha" };
  let res;
  try {
    res = await ctx.fetch(`https://api.github.com/repos/${check.repo}/commits/${evidence.sha}/check-runs?per_page=100`, {
      headers: { accept: "application/vnd.github+json", ...(ctx.githubToken ? { authorization: `Bearer ${ctx.githubToken}` } : {}) },
      signal: AbortSignal.timeout(ctx.timeoutMs ?? 15_000),
    });
  } catch (e) {
    return { status: "fail", detail: `request failed: ${e.message}` };
  }
  if (!res.ok) return { status: "fail", detail: `GitHub returned ${res.status}` };
  const { total_count: total, check_runs: runs } = await res.json();
  if (!Array.isArray(runs) || runs.length === 0) return { status: "fail", detail: "no check runs on that commit" };
  if (total > runs.length) return { status: "fail", detail: "too many check runs to verify in one page" };
  for (const name of check.names ?? []) {
    if (!runs.some(r => r.name === name)) return { status: "fail", detail: `required check "${name}" is missing` };
  }
  const bad = runs.find(r => r.status !== "completed" || r.conclusion !== "success");
  if (bad) return { status: "fail", detail: `check "${bad.name}" is ${bad.status === "completed" ? bad.conclusion : bad.status}` };
  const late = runs.find(r => Date.parse(r.completed_at) > ctx.deadlineMs);
  if (late) return { status: "fail", detail: `check "${late.name}" completed after the deadline` };
  return { status: "pass", detail: `${runs.length} check run(s) succeeded` };
}

function manual(check, _evidence, ctx) {
  const judgment = ctx.judgments?.[check.id];
  if (!judgment) return { status: "needs_judgment", detail: check.question };
  if (typeof judgment.pass !== "boolean" || typeof judgment.by !== "string") {
    return { status: "fail", detail: "judgment needs { pass: boolean, by: string }" };
  }
  if (ctx.judges && !ctx.judges.includes(judgment.by)) {
    return { status: "fail", detail: `${judgment.by} is not an allowed judge for this spec` };
  }
  return { status: judgment.pass ? "pass" : "fail", detail: `judged by ${judgment.by}${judgment.note ? `: ${judgment.note}` : ""}` };
}

export const RUNNERS = { url_up: urlUp, github_pr_merged: githubPrMerged, github_checks_pass: githubChecksPass, file_hash: fileHash, manual };
