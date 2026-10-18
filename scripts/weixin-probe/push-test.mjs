#!/usr/bin/env node
// 微信 iLink 主动推送实测：
//   1. 独占消费 getupdates（OneFleet 已停），等用户发一条消息
//   2. 捕获 senderId + context_token 后跑三组对照：
//      T1 带context_token 立即回复（基线）
//      T2 不带context_token 主动发（验证 token 是否必须）
//      T3 带context_token 延迟15s 主动发（验证"过一会儿推"）
//   3. 游标写回 channels.json
import { readFileSync, writeFileSync, globSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

const BASE = 'https://ilinkai.weixin.qq.com';
const CFG = process.env.ORKAS_CHANNELS_FILE
  || globSync(`${homedir()}/.onefleet/data/*/cloud/config/channels.json`)[0];
const cfg = JSON.parse(readFileSync(CFG, 'utf8'));
const acc = cfg.accounts[0];
const token = acc.token;
const botId = acc.botId;
let cursor = cfg.cursors.weixin || '';

const H = () => ({
  'content-type': 'application/json',
  AuthorizationType: 'ilink_bot_token',
  Authorization: `Bearer ${token}`,
  'X-WECHAT-UIN': Buffer.from(String(Math.floor(Math.random() * 0xffffffff)), 'utf8').toString('base64'),
});
const B = (o) => JSON.stringify({ base_info: { channel_version: '2.0.0' }, ...o });

async function post(path, body, timeout = 95000) {
  const r = await fetch(`${BASE}/ilink/bot${path}`, { method: 'POST', headers: H(), body: B(body), signal: AbortSignal.timeout(timeout) });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { throw new Error(`${path} HTTP ${r.status}: ${t.slice(0, 120)}`); }
  const d = j?.data ? { ...j, ...j.data } : j;
  if ((d.ret ?? 0) !== 0 || (d.errcode ?? 0) !== 0) throw new Error(`${path} ret=${d.ret} ${d.errmsg || d.message || ''}`);
  return d;
}

async function send(to, text, ctx) {
  return post('/sendmessage', {
    msg: {
      from_user_id: botId,
      to_user_id: to,
      client_id: `pushtest-${randomUUID()}`,
      message_type: 2,
      message_state: 2,
      ...(ctx ? { context_token: ctx } : {}),
      item_list: [{ type: 1, text_item: { text } }],
    },
  }, 30000);
}

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

log('等待你的微信消息（发任意内容给机器人）…');
let deadline = Date.now() + 5 * 60_000;
let captured = null;
while (Date.now() < deadline && !captured) {
  let d;
  try {
    d = await post('/getupdates', { get_updates_buf: cursor });
  } catch (e) {
    if (/abort|timeout/i.test(e.message)) continue;
    log('getupdates err:', e.message);
    await new Promise((r) => setTimeout(r, 3000));
    continue;
  }
  cursor = d.get_updates_buf || cursor;
  for (const m of d.msgs || []) {
    if (m.message_type !== 1) continue;
    const sid = m.from_user_id;
    const text = m?.item_list?.[0]?.text_item?.text || '';
    if (!sid || !text) continue;
    captured = { sid, ctx: m.context_token || '', text };
    log(`捕获: from=${sid} ctx=${captured.ctx ? 'Y' : 'N'} text=${text.slice(0, 30)}`);
    break;
  }
}
if (!captured) { log('5 分钟未等到消息，退出'); process.exit(1); }

const { sid, ctx } = captured;
const results = {};
// T1 基线：带 context_token 立即回复
try { await send(sid, '[测试T1] 带context_token的即时回复（基线，预期送达）', ctx); results.T1 = 'OK'; }
catch (e) { results.T1 = 'FAIL: ' + e.message; }
log('T1(带ctx即时):', results.T1);

// T2 主动推送：不带 context_token
try { await send(sid, '[测试T2] 主动推送·不带context_token（验证是否必须）', undefined); results.T2 = 'OK'; }
catch (e) { results.T2 = 'FAIL: ' + e.message; }
log('T2(无ctx主动):', results.T2);

// T3 主动推送：带 context_token，延迟 15s
await new Promise((r) => setTimeout(r, 15000));
try { await send(sid, '[测试T3] 主动推送·带context_token·延迟15秒（定时任务/进度汇报场景）', ctx); results.T3 = 'OK'; }
catch (e) { results.T3 = 'FAIL: ' + e.message; }
log('T3(带ctx延迟15s):', results.T3);

cfg.cursors.weixin = cursor;
writeFileSync(CFG, JSON.stringify(cfg, null, 2));
log('游标已写回。结果汇总:', JSON.stringify(results));
log('请对照手机：T1/T2/T3 各收到几条？');
