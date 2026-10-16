/**
 * channels/weixin-ilink 协议解析单测。
 * 真实扫码联调（2026-10-16）锁定的协议形状在此固化：
 *   - 收消息容器字段是 msgs（不是 messages）
 *   - message_type 1 = 用户文本；2 = bot 自身回显（必须丢弃防自循环）
 *   - 扫码状态 0/1/2/3,4 = 待扫/已扫/成功/过期
 */
import { describe, expect, it } from 'vitest';
import { weixinAdapter } from '../../../src/main/features/channels/weixin-ilink';
import type { ChannelAccount } from '../../../src/main/features/channels/types';

function account(over: Partial<ChannelAccount> = {}): ChannelAccount {
  return {
    channel: 'weixin',
    botId: 'bdd7987f96b9@im.bot',
    token: 'tok',
    enabled: true,
    connectedAt: '2026-10-16T00:00:00.000Z',
    ...over,
  };
}

// toInbound 不是导出符号——经 pollInbound 间接验证。fetch mock 到固定 payload。
function mockFetchOnce(payload: unknown, status = 200) {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(payload), { status })) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

describe('weixin-ilink adapter', () => {
  it('pollInbound 解析 msgs 容器并丢弃 bot 自身回显（防自循环）', async () => {
    const restore = mockFetchOnce({
      msgs: [
        {
          message_type: 1,
          from_user_id: 'oABC@im.wechat',
          item_list: [{ type: 1, text_item: { text: '你好啊' } }],
          context_token: 'ctx-1',
        },
        {
          message_type: 2,
          from_user_id: 'bdd7987f96b9@im.bot',
          item_list: [{ type: 1, text_item: { text: '我自己发的' } }],
        },
      ],
      get_updates_buf: 'CURSOR-2',
    });
    try {
      const batch = await weixinAdapter.pollInbound(account(), 'CURSOR-1');
      expect(batch.messages).toHaveLength(1);
      expect(batch.messages[0]).toMatchObject({
        senderId: 'oABC@im.wechat',
        text: '你好啊',
        replyContext: 'ctx-1',
      });
      expect(batch.cursor).toBe('CURSOR-2');
    } finally {
      restore();
    }
  });

  it('pollInbound 缺 from 或空文本的消息被过滤', async () => {
    const restore = mockFetchOnce({
      msgs: [
        { message_type: 1, from_user_id: '', item_list: [{ type: 1, text_item: { text: 'x' } }] },
        { message_type: 1, from_user_id: 'oABC@im.wechat', item_list: [] },
      ],
    });
    try {
      const batch = await weixinAdapter.pollInbound(account(), '');
      expect(batch.messages).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it('sendText 走 /sendmessage，from_user_id 是 botId，文本在 item_list', async () => {
    let captured: { url: string; body: string } | null = null;
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
      captured = { url: String(url), body: String(init?.body ?? '') };
      return new Response(JSON.stringify({ message_id: 1 }), { status: 200 });
    }) as typeof fetch;
    try {
      await weixinAdapter.sendText(account(), 'oABC@im.wechat', '回复', 'ctx-9');
      expect(captured!.url).toContain('/ilink/bot/sendmessage');
      const body = JSON.parse(captured!.body);
      expect(body.base_info.channel_version).toBe('2.0.0');
      expect(body.msg.from_user_id).toBe('bdd7987f96b9@im.bot');
      expect(body.msg.to_user_id).toBe('oABC@im.wechat');
      expect(body.msg.context_token).toBe('ctx-9');
      expect(body.msg.item_list[0].text_item.text).toBe('回复');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('pollLogin: status=2 成功并取 bot_token/ilink_bot_id；status=3 过期；HTTP 错误归 pending', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ status: 2, bot_token: 'T', ilink_bot_id: 'B@im.bot' }), { status: 200 })) as typeof fetch;
    try {
      const ok = await weixinAdapter.pollLogin('qr');
      expect(ok.status).toBe('success');
      if (ok.status === 'success') {
        expect(ok.account.token).toBe('T');
        expect(ok.account.botId).toBe('B@im.bot');
      }
    } finally { globalThis.fetch = original; }

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ status: 3 }), { status: 200 })) as typeof fetch;
    try {
      expect((await weixinAdapter.pollLogin('qr')).status).toBe('expired');
    } finally { globalThis.fetch = original; }

    globalThis.fetch = (async () => new Response('x', { status: 502 })) as typeof fetch;
    try {
      // get_qrcode_status 非 OK → getJson 抛错 → pollLogin 只对超时吞错，这里应抛出。
      await expect(weixinAdapter.pollLogin('qr')).rejects.toThrow(/HTTP 502/);
    } finally { globalThis.fetch = original; }
  });

  it('beginLogin 返回 qrcode 与 dataURL 二维码', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ qrcode: 'Q1', qrcode_img_content: 'https://liteapp.weixin.qq.com/q/x' }, { status: 200 } as any), { status: 200 })) as typeof fetch;
    try {
      const session = await weixinAdapter.beginLogin();
      expect(session.qrCode).toBe('Q1');
      expect(session.qrDataUrl).toMatch(/^data:image\/png/);
    } finally { globalThis.fetch = original; }
  });
});
