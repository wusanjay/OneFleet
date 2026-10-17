/**
 * channels 编排层：断开保留绑定 + 重扫合并复用原 DM。
 *
 * 背景（HANDOVER 待办 #3）：旧行为 disconnect 整条删 account，重扫后
 * agentId/cid 丢失、DM 会话变孤儿。新行为只失效凭据（token='' + enabled=false），
 * 重扫登录经 updateAccount 合并后复用原绑定与 DM 会话。
 * bot_id 重扫即变（渠道侧新 bot），cid/agentId 是 OneFleet 内部身份，跨重扫连续。
 */
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
}));
vi.mock('../../../src/main/storage', () => ({
  readJson: vi.fn(async () => JSON.parse(JSON.stringify(store))),
  writeJson: vi.fn(async (_path: string, data: unknown) => {
    store = JSON.parse(JSON.stringify(data));
  }),
  nowIso: () => '2026-10-17T00:00:00.000Z',
}));
vi.mock('../../../src/main/paths', () => ({
  userChannelsFile: (uid: string) => `/tmp/test-onefleet/${uid}/channels.json`,
}));
vi.mock('../../../src/main/features/chats', () => ({
  getConversation: vi.fn(),
  createConversation: vi.fn(),
}));
vi.mock('../../../src/main/features/group_chat', () => ({
  setFloor: vi.fn(),
  send: vi.fn(),
  subscribeBus: vi.fn(() => () => {}),
  busIsQuiescent: vi.fn(async () => true),
}));
vi.mock('../../../src/main/features/agents', () => ({ getAgent: vi.fn() }));
vi.mock('../../../src/main/features/channels/weixin-ilink', () => ({
  weixinAdapter: {
    id: 'weixin',
    beginLogin: vi.fn(),
    pollLogin: vi.fn(),
    test: vi.fn(),
    pollInbound: vi.fn(async (_a: unknown, _c: string, signal?: AbortSignal) => {
      if (signal?.aborted) throw new Error('abort');
      await new Promise((r) => setTimeout(r, 20));
      return { messages: [] as unknown[], cursor: 'C' };
    }),
    sendText: vi.fn(),
  },
}));

import { readJson, writeJson } from '../../../src/main/storage';
import {
  beginLogin,
  disconnect,
  pollLogin,
  status,
  stopLoop,
} from '../../../src/main/features/channels';
import { weixinAdapter } from '../../../src/main/features/channels/weixin-ilink';

type StoredAccount = {
  channel: 'weixin';
  botId: string;
  token: string;
  enabled: boolean;
  connectedAt: string;
  agentId?: string;
  cid?: string;
  displayName?: string;
};
type StoredFile = { version: 1; accounts: StoredAccount[]; cursors: Record<string, string> };

let store: StoredFile;

const boundAccount = (): StoredAccount => ({
  channel: 'weixin',
  botId: 'old@im.bot',
  token: 'tok-1',
  enabled: true,
  connectedAt: '2026-10-16T00:00:00.000Z',
  agentId: 'agent-1',
  cid: 'cid-1',
  displayName: '旧昵称',
});

beforeEach(() => {
  vi.clearAllMocks();
  store = { version: 1, accounts: [boundAccount()], cursors: { weixin: 'CUR-1' } };
});

describe('channels 重连保留绑定', () => {
  it('disconnect 只失效凭据（token 空 + enabled=false），保留 botId/agentId/cid 并重置游标', async () => {
    await disconnect('u1');

    expect(writeJson).toHaveBeenCalled();
    expect(store.accounts).toHaveLength(1);
    const acc = store.accounts[0];
    expect(acc.token).toBe('');
    expect(acc.enabled).toBe(false);
    expect(acc.botId).toBe('old@im.bot');
    expect(acc.agentId).toBe('agent-1');
    expect(acc.cid).toBe('cid-1');
    expect(store.cursors.weixin).toBeUndefined();

    const st = await status('u1');
    expect(st.connected).toBe(false);
    // 绑定信息仍在，面板重扫后可预选原机器人
    expect(st.account?.agentId).toBe('agent-1');
    expect(st.account?.cid).toBe('cid-1');
  });

  it('重扫登录经合并保留原 agentId/cid（复用原 DM），botId/token 换新', async () => {
    await disconnect('u1');

    (weixinAdapter.beginLogin as Mock).mockResolvedValue({
      qrCode: 'QR-1',
      expiresAt: Date.now() + 60_000,
      intervalMs: 50,
    });
    await beginLogin('u1');

    // 重扫签发的是新 bot_id + 新 token（陷阱清单 #6）
    (weixinAdapter.pollLogin as Mock).mockResolvedValue({
      status: 'success',
      account: { channel: 'weixin', botId: 'new@im.bot', token: 'tok-2', displayName: '新昵称' },
    });
    const res = await pollLogin('u1');
    expect(res.status).toBe('success');
    stopLoop('u1'); // pollLogin 成功会 void startLoop，测试收尾停掉入站循环

    expect(store.accounts).toHaveLength(1);
    const acc = store.accounts[0];
    expect(acc.botId).toBe('new@im.bot');
    expect(acc.token).toBe('tok-2');
    expect(acc.enabled).toBe(true);
    expect(acc.agentId).toBe('agent-1');
    expect(acc.cid).toBe('cid-1');

    const st = await status('u1');
    expect(st.connected).toBe(true);
  });

  it('未登录过时 disconnect 不产生账号记录', async () => {
    store = { version: 1, accounts: [], cursors: {} };
    await disconnect('u1');
    expect(store.accounts).toHaveLength(0);
    expect(readJson).toHaveBeenCalled();
  });
});
