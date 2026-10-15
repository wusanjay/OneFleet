/**
 * usage-ledger — persisted per-request token usage for cost visibility.
 *
 * The conversation-cost-meter is an in-memory runaway BACKSTOP: it resets on
 * each new user message and keeps no history, so "what did this fleet cost
 * me" was unanswerable. This ledger is the visibility counterpart — one
 * append-only JSONL per conversation under `<data>/usage/<cid>.jsonl`,
 * written from the same settle point the meter charges (the task-budget
 * provider wrapper), read back aggregated by model for the chat UI.
 *
 * Deliberate v1 scope: conversation + model granularity. The provider
 * wrapper cannot see the acting agent id (it lives below the worker loop),
 * so per-actor attribution is future work; the file layout keeps room for it
 * (`actor` field, null for now).
 *
 * Privacy/locality: usage lines stay machine-local (the local data root, not
 * the cloud-synced subtree) and contain no message text — counters only.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { WS_ROOT } from '../paths';
import { appendJsonlAtomic, readJsonl, safeId } from '../storage';

export interface ProviderUsageEntry {
  ts: string;
  cid: string;
  provider: string;
  model: string;
  actor: null | string;
  input_tokens: number;
  output_tokens: number;
}

export interface ModelUsage {
  provider: string;
  model: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
}

export interface ConversationUsageSummary {
  ok: true;
  cid: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  by_model: ModelUsage[];
  first_ts: string | null;
  last_ts: string | null;
}

function usageDir(): string {
  return path.join(WS_ROOT, 'usage');
}

function usageFile(cid: string): string {
  if (!safeId(cid)) throw new Error('invalid cid');
  return path.join(usageDir(), `${cid}.jsonl`);
}

/** Record one settled provider request. Best-effort by design: a ledger
 * write must never break a live model call, so every failure is swallowed
 * with a console warning. */
export function recordProviderUsage(entry: {
  cid: string;
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
}): void {
  try {
    const inTok = Math.max(0, Math.trunc(entry.inputTokens ?? 0));
    const outTok = Math.max(0, Math.trunc(entry.outputTokens ?? 0));
    if (!inTok && !outTok) return;
    const line: ProviderUsageEntry = {
      ts: new Date().toISOString(),
      cid: entry.cid,
      provider: String(entry.provider || ''),
      model: String(entry.model || ''),
      actor: null,
      input_tokens: inTok,
      output_tokens: outTok,
    };
    fs.mkdirSync(usageDir(), { recursive: true });
    void appendJsonlAtomic(usageFile(entry.cid), line).catch((appendErr) => {
      console.warn(`[usage-ledger] append failed: ${(appendErr as Error).message}`);
    });
  } catch (err) {
    console.warn(`[usage-ledger] record failed: ${(err as Error).message}`);
  }
}

/** Aggregate one conversation's ledger by model. Missing/empty file reads as
 * an all-zero summary so callers can render without special cases. */
export async function conversationUsageSummary(cid: string): Promise<ConversationUsageSummary> {
  const empty: ConversationUsageSummary = {
    ok: true,
    cid,
    requests: 0,
    input_tokens: 0,
    output_tokens: 0,
    by_model: [],
    first_ts: null,
    last_ts: null,
  };
  if (!safeId(cid)) return empty;
  let lines: ProviderUsageEntry[] = [];
  try {
    lines = (await readJsonl<ProviderUsageEntry>(usageFile(cid))).filter(
      (l) => l && typeof l.input_tokens === 'number',
    );
  } catch {
    return empty;
  }
  const byModel = new Map<string, ModelUsage>();
  let inSum = 0;
  let outSum = 0;
  let first: string | null = null;
  let last: string | null = null;
  for (const l of lines) {
    inSum += l.input_tokens || 0;
    outSum += l.output_tokens || 0;
    if (l.ts && (!first || l.ts < first)) first = l.ts;
    if (l.ts && (!last || l.ts > last)) last = l.ts;
    const key = `${l.provider}/${l.model}`;
    const bucket = byModel.get(key) || {
      provider: l.provider,
      model: l.model,
      requests: 0,
      input_tokens: 0,
      output_tokens: 0,
    };
    bucket.requests += 1;
    bucket.input_tokens += l.input_tokens || 0;
    bucket.output_tokens += l.output_tokens || 0;
    byModel.set(key, bucket);
  }
  return {
    ok: true,
    cid,
    requests: lines.length,
    input_tokens: inSum,
    output_tokens: outSum,
    by_model: [...byModel.values()].sort((a, b) => b.output_tokens - a.output_tokens),
    first_ts: first,
    last_ts: last,
  };
}
