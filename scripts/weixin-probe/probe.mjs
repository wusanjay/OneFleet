#!/usr/bin/env node
// 微信 iLink bot API 探针（协议逆向自 zai-org/ZCode，Apache-2.0）
// 用法：
//   node probe.mjs login           # 出二维码，扫码后保存 token 到 token.json
//   node probe.mjs listen          # 长轮询收消息并回显（需先 login）
//   node probe.mjs test            # 验证已存 token 是否可用
import { writeFileSync, existsSync, readFileSync, globSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomInt, randomUUID } from 'node:crypto';

const BASE = 'https://ilinkai.weixin.qq.com';
const PREFIX = '/ilink/bot';
// channels.json 定位：环境变量优先，否则按数据目录 glob（uid 因机器而异）。
// 凭据只落 channels.json（与主应用同一存储），绝不写进本目录，避免误提交活 token。
const CFG_FILE = process.env.ORKAS_CHANNELS_FILE
  || globSync(`${homedir()}/.onefleet/data/*/cloud/config/channels.json`)[0];
function loadCfg() {
  return JSON.parse(readFileSync(CFG_FILE, 'utf8'));
}
function saveToken(newToken, newBotId) {
  const cfg = existsSync(CFG_FILE) ? loadCfg() : { version: 1, accounts: [], cursors: {} };
  const i = cfg.accounts.findIndex((a) => a.channel === 'weixin');
  const acct = { channel: 'weixin', botId: newBotId, token: newToken, enabled: true, connectedAt: new Date().toISOString(), ...((i >= 0 && cfg.accounts[i]) || {}) };
  if (i >= 0) cfg.accounts[i] = acct; else cfg.accounts.push(acct);
  writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2));
}

const headers = (token) => ({
  'content-type': 'application/json',
  AuthorizationType: 'ilink_bot_token',
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
  'X-WECHAT-UIN': Buffer.from(String(randomInt(0, 0x100000000)), 'utf8').toString('base64'),
});
const body = (o) => JSON.stringify({ base_info: { channel_version: '2.0.0' }, ...o });

async function getJson(path, token) {
  const r = await fetch(`${BASE}${PREFIX}${path}`, {
    headers: { 'iLink-App-ClientVersion': '1', ...(token ? headers(token) : {}) },
    signal: AbortSignal.timeout(30000),
  });
  const payload = await r.json().catch(() => ({}));
  const data = payload?.data ? { ...payload, ...payload.data } : payload;
  const ret = data?.ret ?? data?.errcode;
  if (ret !== undefined && ret !== null && ret !== 0) {
    throw new Error(`${path} failed: ret=${ret} ${data?.errmsg || data?.message || ''}`);
  }
  return data;
}

async function postJson(path, obj, token, timeoutMs = 30000) {
  const r = await fetch(`${BASE}${PREFIX}${path}`, {
    method: 'POST',
    headers: headers(token),
    body: body(obj),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await r.json().catch(() => ({}));
  const data = payload?.data ? { ...payload, ...payload.data } : payload;
  const ret = data?.ret ?? data?.errcode;
  if (ret !== undefined && ret !== null && ret !== 0) {
    throw new Error(`${path} failed: ret=${ret} ${data?.errmsg || data?.message || ''}`);
  }
  return data;
}

async function login() {
  console.log('[1] 请求二维码…');
  const qr = await getJson('/get_bot_qrcode?bot_type=3');
  const qrCode = qr.qrcode || qr.qr_code || '';
  const img = qr.qrcode_img_content || qr.qrcode_url || '';
  console.log('    返回字段:', Object.keys(qr).join(', '));
  if (img.startsWith('data:image') || /^[A-Za-z0-9+/=]{100,}$/.test(img)) {
    const b64 = img.includes(',') ? img.split(',')[1] : img;
    const file = new URL('./qr.png', import.meta.url).pathname;
    writeFileSync(file, Buffer.from(b64, 'base64'));
    console.log(`    二维码已保存: ${file} （可用预览打开扫码）`);
  } else if (img) {
    console.log(`    二维码内容/链接: ${img}`);
  }
  console.log(`    qrcode=${qrCode}`);
  console.log('[2] 每 3 秒轮询扫码状态（120s 内有效），请用微信扫码…');
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    let s;
    try {
      s = await getJson(`/get_qrcode_status?qrcode=${encodeURIComponent(qrCode)}`);
    } catch (e) {
      console.log('    poll 超时重试:', e.message);
      continue;
    }
    const status = s.status ?? s.qrcode_status ?? s.qr_status;
    console.log(`    status=${status}`);
    if (status === 2 || ['confirmed', 'success', 'ok'].includes(String(status).toLowerCase())) {
      const token = s.bot_token || s.token || '';
      if (!token) { console.error('    登录成功但未返回 bot_token:', Object.keys(s).join(', ')); process.exit(1); }
      saveToken(token, s.ilink_bot_id || s.bot_id || '');
      console.log(`[3] 登录成功！bot_id=${s.ilink_bot_id || s.bot_id || '(未返回)'} token 已存 ${CFG_FILE}`);
      return;
    }
    if (status === 3 || status === 4) { console.error('    二维码已过期，重跑 login'); process.exit(1); }
  }
  console.error('    超时未确认');
  process.exit(1);
}

function loadAccount() {
  if (!existsSync(CFG_FILE)) { console.error('未找到 channels.json，请先 node probe.mjs login'); process.exit(1); }
  const a = loadCfg().accounts.find((x) => x.channel === 'weixin');
  if (!a) { console.error('channels.json 无 weixin 账号，请先 login'); process.exit(1); }
  return a;
}

async function test() {
  const a = loadAccount();
  const cfg = await postJson('/getconfig', { ilink_user_id: '' }, a.token).catch(() => ({}));
  console.log('account:', a.botId);
  console.log('getconfig OK，字段:', Object.keys(cfg).join(', '));
}

async function listen() {
  const { token, bot_id } = loadAccount();
  console.log('长轮询中…请在微信里给机器人发一条消息（Ctrl+C 退出）');
  let buf = '';
  while (true) {
    let payload;
    try {
      payload = await postJson('/getupdates', { get_updates_buf: buf }, token, 95000);
    } catch (e) {
      if (String(e.message).includes('abort') || String(e.message).includes('Timeout')) continue;
      console.error('getupdates:', e.message);
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    const nextBuf = payload.get_updates_buf || payload.buf || payload.next_buf || '';
    const raw = payload.msgs || payload.messages || payload.msg_list || [];
    for (const m of Array.isArray(raw) ? raw : []) {
      console.log('--- 原始消息字段:', JSON.stringify(m).slice(0, 600));
      const from = m.from_user_id || m.from || m.user_id || m?.from?.user_id || '';
      const ctx = m.context_token || m.contextToken || m?.inner?.context_token || '';
      const text = m?.item_list?.[0]?.text_item?.text || m?.content?.text || JSON.stringify(m).slice(0, 200);
      console.log(`    from=${from} ctx=${ctx ? 'yes' : 'no'} text=${text}`);
      if (from) {
        await postJson('/sendmessage', {
          msg: {
            from_user_id: bot_id,
            to_user_id: from,
            client_id: `probe-${randomUUID()}`,
            message_type: 2,
            message_state: 2,
            ...(ctx ? { context_token: ctx } : {}),
            item_list: [{ type: 1, text_item: { text: `[OneFleet 探针] 收到: ${String(text).slice(0, 100)}` } }],
          },
        }, token);
        console.log('    已回显');
      }
    }
    buf = nextBuf || buf;
  }
}

const cmd = process.argv[2];
if (cmd === 'login') await login();
else if (cmd === 'test') await test();
else if (cmd === 'listen') await listen();
else console.log('用法: node probe.mjs login | test | listen（channels.json 由 ORKAS_CHANNELS_FILE 或 ~/.onefleet 数据目录 glob 定位）');
