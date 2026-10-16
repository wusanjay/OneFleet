/**
 * channels/index.ts — 远程消息渠道（微信 first）功能入口。
 *
 * 职责：账号持久化（<uid>/cloud/config/channels.json）、扫码登录会话、
 * 入站长轮询循环（每用户单例）、入站消息 → 绑定机器人 DM 的注入与回复捕获。
 *
 * 注入路径复用渲染器同一条生产入口：
 *   groupChat.setFloor(uid, cid, agentId) → groupChat.send(...) →
 *   subscribeBus 收集 turn_end 回复 → adapter.sendText 回微信。
 */
import { createLogger } from '../../logger';
import { readJson, writeJson, nowIso } from '../../storage';
import { userChannelsFile } from '../../paths';
import * as chats from '../chats';
import * as groupChat from '../group_chat';
import * as agents from '../agents';
import { weixinAdapter } from './weixin-ilink';
import type { ChannelAccount, ChannelAdapter, ChannelId, ChannelInboundMessage } from './types';

const log = createLogger('channels');

const ADAPTERS: Record<ChannelId, ChannelAdapter> = { weixin: weixinAdapter };
const REPLY_TIMEOUT_MS = 10 * 60_000;

interface ChannelsFile {
  version: 1;
  accounts: ChannelAccount[];
  cursors: Record<string, string>;
}

function emptyFile(): ChannelsFile {
  return { version: 1, accounts: [], cursors: {} };
}

async function readFile(uid: string): Promise<ChannelsFile> {
  return (await readJson<ChannelsFile>(userChannelsFile(uid))) ?? emptyFile();
}

async function writeFile(uid: string, file: ChannelsFile): Promise<void> {
  await writeJson(userChannelsFile(uid), file);
}

export async function getAccount(uid: string, channel: ChannelId = 'weixin'): Promise<ChannelAccount | undefined> {
  return (await readFile(uid)).accounts.find((a) => a.channel === channel);
}

async function updateAccount(uid: string, patch: Partial<ChannelAccount> & { channel: ChannelId }): Promise<ChannelAccount> {
  const file = await readFile(uid);
  const idx = file.accounts.findIndex((a) => a.channel === patch.channel);
  const next: ChannelAccount = idx >= 0
    ? { ...file.accounts[idx], ...patch }
    : { enabled: true, connectedAt: nowIso(), ...patch } as ChannelAccount;
  if (idx >= 0) file.accounts[idx] = next; else file.accounts.push(next);
  await writeFile(uid, file);
  return next;
}

export async function disconnect(uid: string, channel: ChannelId = 'weixin'): Promise<void> {
  stopLoop(uid, channel);
  const file = await readFile(uid);
  file.accounts = file.accounts.filter((a) => a.channel !== channel);
  delete file.cursors[channel];
  await writeFile(uid, file);
}

// ── 扫码登录 ─────────────────────────────────────────────────────────────

export async function beginLogin(uid: string, channel: ChannelId = 'weixin') {
  const adapter = ADAPTERS[channel];
  const session = await adapter.beginLogin();
  loginSessions.set(`${uid}:${channel}`, session.qrCode);
  return session;
}

const loginSessions = new Map<string, string>();

export async function pollLogin(uid: string, channel: ChannelId = 'weixin') {
  const adapter = ADAPTERS[channel];
  const qrCode = loginSessions.get(`${uid}:${channel}`);
  if (!qrCode) return { status: 'error' as const, message: '登录会话不存在，请重新发起' };
  const result = await adapter.pollLogin(qrCode);
  if (result.status === 'success') {
    loginSessions.delete(`${uid}:${channel}`);
    const account = await updateAccount(uid, { ...result.account, enabled: true });
    void startLoop(uid, channel);
    return { status: 'success' as const, account: publicAccount(account) };
  }
  if (result.status === 'expired') loginSessions.delete(`${uid}:${channel}`);
  return result;
}

function publicAccount(account: ChannelAccount) {
  return { ...account, token: '' };
}

// ── 入站循环与消息注入 ────────────────────────────────────────────────────

const loopAborts = new Map<string, AbortController>();

export async function startLoop(uid: string, channel: ChannelId = 'weixin'): Promise<void> {
  const key = `${uid}:${channel}`;
  if (loopAborts.has(key)) return;
  const account = await getAccount(uid, channel);
  if (!account?.enabled || !account.token) return;
  const controller = new AbortController();
  loopAborts.set(key, controller);
  void pollLoop(uid, channel, controller.signal).catch((error) => {
    log.warn(`[${key}] 入站循环退出:`, error instanceof Error ? error.message : error);
  });
}

export function stopLoop(uid: string, channel: ChannelId = 'weixin'): void {
  loopAborts.get(`${uid}:${channel}`)?.abort();
  loopAborts.delete(`${uid}:${channel}`);
}

/** 应用启动时恢复所有已连接渠道的入站循环。 */
export async function bootstrapAllLoops(uid: string): Promise<void> {
  const file = await readFile(uid);
  for (const account of file.accounts) {
    if (account.enabled && account.agentId) await startLoop(uid, account.channel);
  }
}

async function pollLoop(uid: string, channel: ChannelId, signal: AbortSignal): Promise<void> {
  const adapter = ADAPTERS[channel];
  const key = `${uid}:${channel}`;
  let cursor = (await readFile(uid)).cursors[channel] ?? '';
  log.info(`[${key}] 入站循环启动`);
  while (!signal.aborted) {
    const account = await getAccount(uid, channel);
    if (!account?.enabled || !account.token) break;
    try {
      const batch = await adapter.pollInbound(account, cursor, signal);
      cursor = batch.cursor;
      const file = await readFile(uid);
      file.cursors[channel] = cursor;
      await writeFile(uid, file);
      for (const message of batch.messages) {
        await handleInbound(uid, account, message);
      }
    } catch (error) {
      if (signal.aborted) break;
      const msg = error instanceof Error ? error.message : String(error);
      if (/abort/i.test(msg)) break;
      // 凭据失效等致命错误：停循环、标记断连，等用户重新扫码。
      if (/HTTP 40[13]/.test(msg)) {
        log.warn(`[${key}] 凭据失效，停止入站循环`);
        await updateAccount(uid, { channel, enabled: false });
        break;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  log.info(`[${key}] 入站循环结束`);
}

async function handleInbound(uid: string, account: ChannelAccount, message: ChannelInboundMessage): Promise<void> {
  if (!account.agentId) {
    log.info(`[channels] 微信消息到达但未绑定机器人: ${message.text.slice(0, 40)}`);
    return;
  }
  const cid = await ensureConversation(uid, account);
  await groupChat.setFloor(uid, cid, account.agentId!);
  const adapter = ADAPTERS[account.channel];
  // 对方正在输入…：生成回复期间每 5s 续发一次 typing（微信端会自动过期）。
  // status 由 sendmessage 落消息自然终止，这里只负责生成期间的续期。
  let typingTimer: ReturnType<typeof setInterval> | null = null;
  if (adapter.sendTyping) {
    const tick = () => {
      void adapter.sendTyping!(account, message.senderId, message.replyContext).catch(() => {});
    };
    tick();
    typingTimer = setInterval(tick, 5000);
  }
  try {
    const reply = await injectAndWaitReply(uid, cid, account.agentId, message.text);
    await adapter.sendText(account, message.senderId, reply || '（机器人本轮没有产出文本回复）');
  } catch (error) {
    log.warn('[channels] 回复投递失败:', error instanceof Error ? error.message : error);
  } finally {
    if (typingTimer) clearInterval(typingTimer);
  }
}

async function ensureConversation(uid: string, account: ChannelAccount): Promise<string> {
  if (account.cid) {
    const existing = await chats.getConversation(uid, account.cid).catch(() => undefined);
    if (existing && !existing.deleted_at) return account.cid;
  }
  const agent = await agents.getAgent(account.agentId).catch(() => null);
  const title = `微信 · ${agent?.name || '机器人'}`;
  const conv = await chats.createConversation(uid, { agentId: account.agentId!, title });
  await updateAccount(uid, { channel: account.channel, cid: conv.conversation_id });
  return conv.conversation_id;
}

/** 注入一条用户消息，等绑定机器人的 turn_end 回复，拼接文本返回。 */
async function injectAndWaitReply(uid: string, cid: string, agentId: string, text: string): Promise<string> {
  const parts: string[] = [];
  let finished = false;
  const unsubscribe = groupChat.subscribeBus(uid, cid, (event: unknown) => {
    const ev = event as { type?: string; msg?: { from?: string; text?: string }; turn_end?: boolean };
    if (ev?.type === 'message' && ev.turn_end && ev.msg?.from === agentId && ev.msg.text) {
      parts.push(ev.msg.text);
    }
  });
  try {
    const result = await groupChat.send({ userId: uid, cid, text });
    if (!result.ok) return '';
    const deadline = Date.now() + REPLY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (parts.length > 0 && (await groupChat.busIsQuiescent(uid, cid))) { finished = true; break; }
      await new Promise((r) => setTimeout(r, 500));
    }
  } finally {
    unsubscribe();
  }
  if (!finished && parts.length === 0) log.warn(`[channels] 回复超时 cid=${cid}`);
  return parts.join('\n\n').trim();
}

// ── 绑定与状态 ───────────────────────────────────────────────────────────

export async function bindAgent(uid: string, agentId: string, channel: ChannelId = 'weixin') {
  const agent = await agents.getAgent(agentId).catch(() => null);
  if (!agent) throw new Error('机器人不存在');
  const account = await updateAccount(uid, { channel, agentId, cid: undefined });
  await startLoop(uid, channel);
  return publicAccount(account);
}

export async function status(uid: string, channel: ChannelId = 'weixin') {
  const account = await getAccount(uid, channel);
  return {
    connected: !!(account?.enabled && account.token),
    account: account ? publicAccount(account) : undefined,
    looping: loopAborts.has(`${uid}:${channel}`),
  };
}
