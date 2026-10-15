import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir = '';
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-ledger-'));
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  // re-resolve WS_ROOT per test via resetModules in consumer tests; here the
  // ledger reads paths lazily through storage, so re-import per test:
});

describe('usage ledger', () => {
  it('records and aggregates by model', async () => {
    const cid = `agg${Date.now()}${Math.floor(Math.random()*1e6)}`;
    const { recordProviderUsage, conversationUsageSummary } = await import('../../src/main/util/usage-ledger');
    recordProviderUsage({ cid, provider: 'zai', model: 'glm-5.3-flash', inputTokens: 1000, outputTokens: 50 });
    recordProviderUsage({ cid, provider: 'zai', model: 'glm-5.3-flash', inputTokens: 2000, outputTokens: 80 });
    recordProviderUsage({ cid, provider: 'zai', model: 'glm-5.3', inputTokens: 500, outputTokens: 20 });
    recordProviderUsage({ cid, provider: 'zai', model: 'glm-5.3', inputTokens: 0, outputTokens: 0 }); // skipped
    await new Promise((r) => setTimeout(r, 50)); // appends are fire-and-forget
    const s = await conversationUsageSummary(cid);
    expect(s.requests).toBe(3);
    expect(s.input_tokens).toBe(3500);
    expect(s.output_tokens).toBe(150);
    expect(s.by_model).toHaveLength(2);
    expect(s.by_model[0].model).toBe('glm-5.3-flash'); // sorted by output desc
  });

  it('zero summary for unknown cid', async () => {
    const cid = `none${Date.now()}${Math.floor(Math.random()*1e6)}`;
    const { conversationUsageSummary } = await import('../../src/main/util/usage-ledger');
    const s = await conversationUsageSummary(cid);
    expect(s.requests).toBe(0);
    expect(s.by_model).toEqual([]);
  });

  it('best-effort: unsafe cid neither throws nor writes', async () => {
    const { recordProviderUsage, conversationUsageSummary } = await import('../../src/main/util/usage-ledger');
    expect(() => recordProviderUsage({ cid: '../evil', provider: 'zai', model: 'm', inputTokens: 1 })).not.toThrow();
    const s = await conversationUsageSummary('../evil');
    expect(s.requests).toBe(0);
  });
});

// usage-ledger captures WS_ROOT once per module graph (paths.ts). This file
// therefore uses unique random cids per test instead of resetting modules —
// writes land under the setup-env temp root without cross-test collisions.
