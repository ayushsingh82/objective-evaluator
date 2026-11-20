import { specHash } from "../src/spec.ts";
import type { Check, Evidence, FetchLike, HttpResponse, Spec } from "../src/types.ts";

export const reply = (o: Partial<HttpResponse> = {}): HttpResponse => ({
  ok: true,
  status: 200,
  json: async () => ({}),
  text: async () => "",
  ...o,
});

export const makeSpec = (checks: Check[], deadline = "2026-12-31T00:00:00Z"): Spec => ({ version: 1, title: "t", deadline, checks });

export const makeEvidence = (spec: Spec, items: Record<string, unknown>, submittedAt = "2026-12-01T00:00:00Z"): Evidence => ({
  specHash: specHash(spec),
  submittedAt,
  items,
});

export const okFetch = (body = "hello world"): FetchLike => async () => reply({ text: async () => body });
