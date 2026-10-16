/**
 * channels/types.ts — 外部消息渠道（远程）抽象。
 *
 * 渠道 = 一个把外部 IM 消息接送进 OneFleet 的 adapter。参考 ZCode bots 的
 * BotProviderAdapter 形状：必选方法压到最少（test/send/pollInbound），能力差异
 * 通过可选方法表达；共享逻辑（登录态、轮询循环、消息注入、回复捕获）全部住在
 * features/channels/index.ts，新增渠道（飞书/Telegram/企微）只写 adapter。
 */

export type ChannelId = 'weixin';

/** 渠道登录/连接后持久化的账号。token 类字段只落本地用户目录。 */
export interface ChannelAccount {
  channel: ChannelId;
  /** 渠道侧的机器人身份（weixin: ilink bot_id，如 `xxx@im.bot`）。 */
  botId: string;
  /** 凭据（weixin: ilink bot_token）。 */
  token: string;
  enabled: boolean;
  connectedAt: string;
  /** 绑定的机器人员工（agent id）；空 = 未绑定（只登录不路由）。 */
  agentId?: string;
  /** 绑定机器人的 DM 会话；首次入站消息时创建。 */
  cid?: string;
  /** 扫码登录的微信用户昵称（渠道回报则存）。 */
  displayName?: string;
}

/** 归一化后的入站消息——所有渠道都映射成这个形状。 */
export interface ChannelInboundMessage {
  /** 渠道内的发送者 id（weixin: `xxx@im.wechat`）。 */
  senderId: string;
  text: string;
  /** 回复该消息所需的渠道上下文（weixin: context_token，透传用）。 */
  replyContext?: string;
  raw?: unknown;
}

/** 渠道 adapter。泛型 R 是渠道原生轮询游标。 */
export interface ChannelAdapter {
  id: ChannelId;
  /** 发起扫码登录。qrDataUrl 供渲染器直接 <img> 展示。 */
  beginLogin(): Promise<{ qrCode: string; qrUrl?: string; qrDataUrl?: string; expiresAt: number; intervalMs: number }>;
  /** 轮询扫码状态直到 success/expired/error。 */
  pollLogin(qrCode: string): Promise<
    | { status: 'pending' | 'scanned' }
    | { status: 'success'; account: Omit<ChannelAccount, 'enabled' | 'connectedAt' | 'agentId' | 'cid'> }
    | { status: 'expired' | 'error'; message?: string }
  >;
  /** 凭据连通性检测。 */
  test(account: ChannelAccount): Promise<{ ok: boolean; message: string }>;
  /** 拉取一批入站消息；返回新游标。长轮询由实现自定超时。 */
  pollInbound(
    account: ChannelAccount,
    cursor: string,
    signal?: AbortSignal,
  ): Promise<{ messages: ChannelInboundMessage[]; cursor: string }>;
  /** 发文本消息。replyContext 来自最近一条入站消息。 */
  sendText(
    account: ChannelAccount,
    toSenderId: string,
    text: string,
    replyContext?: string,
  ): Promise<void>;
  sendTyping?(account: ChannelAccount, toSenderId: string, replyContext?: string): Promise<void>;
}
