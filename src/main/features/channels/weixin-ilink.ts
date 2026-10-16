/**
 * channels/weixin-ilink.ts — 微信 iLink 机器人渠道 adapter。
 *
 * 协议端点 https://ilinkai.weixin.qq.com/ilink/bot/*，为微信官方机器人平台
 * （"微信 ClawBot" 同源）。协议字段经真实扫码实测验证（2026-10-16）：
 *   - GET  /get_bot_qrcode?bot_type=3   → { qrcode, qrcode_img_content }
 *   - GET  /get_qrcode_status?qrcode=…  → { status: 0待扫/1已扫/2成功/3,4过期, bot_token }
 *   - POST /getupdates { get_updates_buf } → { msgs: [...], get_updates_buf }（容器字段是 msgs）
 *   - POST /sendmessage { msg: { from_user_id: <bot_id>, to_user_id, context_token, item_list } }
 *   - 鉴权头：AuthorizationType: ilink_bot_token + Bearer <token>；90s 长轮询挂起
 */
import { randomInt, randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import type {
  ChannelAdapter,
  ChannelAccount,
  ChannelInboundMessage,
} from './types';

const BASE_URL = 'https://ilinkai.weixin.qq.com';
const API_PREFIX = '/ilink/bot';
const CHANNEL_VERSION = '2.0.0';
const LOGIN_TIMEOUT_MS = 30_000;
const POLL_TIMEOUT_MS = 95_000;

type Json = Record<string, unknown>;

function isRecord(v: unknown): v is Json {
  return typeof v === 'object' && v !== null;
}
function str(rec: Json | null | undefined, key: string): string {
  const v = rec?.[key];
  return typeof v === 'string' ? v : '';
}
function num(rec: Json | null | undefined, key: string): number | null {
  const v = rec?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function baseHeaders(token?: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    'X-WECHAT-UIN': Buffer.from(String(randomInt(0, 0x1_0000_0000)), 'utf8').toString('base64'),
  };
}

/** 请求体统一带 base_info.channel_version。 */
function reqBody(body: Json): string {
  return JSON.stringify({ base_info: { channel_version: CHANNEL_VERSION }, ...body });
}

function unwrapData(payload: unknown): Json {
  if (!isRecord(payload)) return {};
  return isRecord(payload.data) ? { ...payload, ...payload.data } : payload;
}

function assertRet(data: Json, path: string): void {
  const ret = num(data, 'ret');
  const errcode = num(data, 'errcode');
  if ((ret !== null && ret !== 0) || (errcode !== null && errcode !== 0)) {
    throw new Error(str(data, 'errmsg') || str(data, 'message') || `weixin ${path}: ret=${ret ?? ''} errcode=${errcode ?? ''}`);
  }
}

async function getJson(path: string, token?: string): Promise<Json> {
  const res = await fetch(`${BASE_URL}${API_PREFIX}${path}`, {
    headers: { 'iLink-App-ClientVersion': '1', ...baseHeaders(token) },
    signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`weixin ${path}: HTTP ${res.status}`);
  const data = unwrapData(await res.json().catch(() => ({})));
  assertRet(data, path);
  return data;
}

async function postJson(path: string, body: Json, token: string, timeoutMs = LOGIN_TIMEOUT_MS): Promise<Json> {
  const res = await fetch(`${BASE_URL}${API_PREFIX}${path}`, {
    method: 'POST',
    headers: baseHeaders(token),
    body: reqBody(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`weixin ${path}: HTTP ${res.status}`);
  const data = unwrapData(await res.json().catch(() => ({})));
  assertRet(data, path);
  return data;
}

function readText(item: unknown): string {
  if (!isRecord(item)) return '';
  const textItem = isRecord(item.text_item) ? item.text_item : null;
  return textItem ? str(textItem, 'text') : '';
}

function toInbound(raw: unknown): ChannelInboundMessage | null {
  if (!isRecord(raw)) return null;
  // message_type 1 = 用户文本（bot 自己回显是 2，跳过避免自循环）。
  const type = num(raw, 'message_type');
  if (type !== null && type !== 1) return null;
  const items = Array.isArray(raw.item_list) ? raw.item_list : [];
  const text = items.map(readText).filter(Boolean).join('\n').trim();
  const senderId = str(raw, 'from_user_id');
  if (!senderId || !text) return null;
  return { senderId, text, replyContext: str(raw, 'context_token') || undefined, raw };
}

export const weixinAdapter: ChannelAdapter = {
  id: 'weixin',

  async beginLogin() {
    const data = await getJson('/get_bot_qrcode?bot_type=3');
    const qrCode = str(data, 'qrcode') || str(data, 'qr_code');
    if (!qrCode) throw new Error('weixin login: 未返回 qrcode');
    // qrcode_img_content 实测是 liteapp.weixin.qq.com 链接（渲染端自行转二维码图）。
    const qrUrl = str(data, 'qrcode_img_content') || str(data, 'qrcode_url') || qrCode;
    const qrDataUrl = await QRCode.toDataURL(qrUrl, { width: 320, margin: 1 });
    const expiresIn = num(data, 'expires_in') ?? num(data, 'expire_time') ?? 120;
    return { qrCode, qrUrl, qrDataUrl, expiresAt: Date.now() + expiresIn * 1000, intervalMs: 3000 };
  },

  async pollLogin(qrCode) {
    let data: Json;
    try {
      data = await getJson(`/get_qrcode_status?qrcode=${encodeURIComponent(qrCode)}`);
    } catch (error) {
      // 手机端确认会让该请求长时间挂起；超时按 pending 继续轮询。
      if (error instanceof Error && /abort|timeout/i.test(error.message)) {
        return { status: 'pending' as const };
      }
      throw error;
    }
    const raw = data.status ?? data.qrcode_status ?? data.qr_status;
    const status = String(raw ?? '').toLowerCase();
    const statusCode = typeof raw === 'number' ? raw : Number.NaN;
    if (statusCode === 2 || ['confirmed', 'confirm', 'success', 'ok', '2'].includes(status)) {
      const token = str(data, 'bot_token') || str(data, 'token');
      if (!token) return { status: 'error' as const, message: '登录成功但未返回 bot_token' };
      return {
        status: 'success' as const,
        account: {
          channel: 'weixin' as const,
          botId: str(data, 'ilink_bot_id') || str(data, 'bot_id'),
          token,
          displayName: str(data, 'nickname') || str(data, 'display_name') || undefined,
        },
      };
    }
    if (statusCode === 3 || statusCode === 4 || ['expired', 'timeout', 'cancel', '3', '4'].includes(status)) {
      return { status: 'expired' as const };
    }
    if (statusCode === 1 || ['scaned', 'scanned', 'scan', '1'].includes(status)) return { status: 'scanned' as const };
    return { status: 'pending' as const };
  },

  async test(account) {
    // getconfig 需要 ilink_user_id；这里用空游标 getupdates 做连通性证明。
    await postJson('/getupdates', { get_updates_buf: '' }, account.token, 15_000);
    return { ok: true, message: '微信 iLink API 连接正常' };
  },

  async pollInbound(account, cursor, signal) {
    const data = await postJson(
      '/getupdates',
      { get_updates_buf: cursor },
      account.token,
      POLL_TIMEOUT_MS,
    );
    const msgs = Array.isArray(data.msgs) ? data.msgs : [];
    const next = str(data, 'get_updates_buf') || cursor;
    return {
      messages: msgs.map(toInbound).filter((m): m is ChannelInboundMessage => m !== null),
      cursor: next,
    };
  },

  async sendText(account, toSenderId, text, replyContext) {
    await postJson('/sendmessage', {
      msg: {
        from_user_id: account.botId,
        to_user_id: toSenderId,
        client_id: `orkas-${randomUUID()}`,
        message_type: 2,
        message_state: 2,
        ...(replyContext ? { context_token: replyContext } : {}),
        item_list: [{ type: 1, text_item: { text } }],
      },
    }, account.token);
  },

  async sendTyping(account, toSenderId, replyContext) {
    const config = await postJson('/getconfig', {
      ilink_user_id: toSenderId,
      ...(replyContext ? { context_token: replyContext } : {}),
    }, account.token);
    const ticket = str(config, 'typing_ticket');
    if (!ticket) return;
    await postJson('/sendtyping', {
      ilink_user_id: toSenderId,
      typing_ticket: ticket,
      status: 1,
    }, account.token);
  },
};
