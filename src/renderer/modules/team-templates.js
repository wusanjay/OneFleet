/* ─── Team templates (编队模板) ─────────────────────────────────────────────
 * The "Import fleet template" entry on the AI Team page. One YAML file
 * provisions the whole fleet: agents, personas, model entry, the group
 * conversation, and the first task (see features/team_templates.ts on the
 * main-process side). On success we jump straight into the new conversation
 * — the welcome task starting to run IS the confirmation.
 *
 * Deliberately thin: no manifest caching, no library grid yet (W3+). The
 * server remains the trust boundary; this module only picks a file and
 * forwards its text.                                                          */
(function () {
  'use strict';

  const _log = (typeof createLogger === 'function') ? createLogger('team-templates') : null;

  function _btn() { return document.getElementById('team-template-import-btn'); }
  function _fileInput() { return document.getElementById('team-template-file-input'); }

  function _setBusy(busy) {
    const el = _btn();
    if (el) el.disabled = !!busy;
  }

  async function _importFile(file) {
    const text = await file.text();
    if (!text.trim()) throw new Error('empty file');
    const res = await window.orkas.invoke('teamTemplates.import', { yaml_text: text });
    if (!res || res.ok !== true) {
      throw new Error((res && res.error) || 'import failed');
    }
    return res;
  }

  async function _onFileChosen(event) {
    const input = event.target;
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    _setBusy(true);
    try {
      const res = await _importFile(file);
      _log?.info?.(`template imported: ${res.team_id} → cid ${res.conversation_id}`);
      if (Array.isArray(res.warnings) && res.warnings.length) {
        // Non-fatal fallbacks (unknown icon fell back, no api key yet) are
        // surfaced once — the conversation itself is the primary feedback.
        window.alert(res.warnings.join('\n'));
      }
      if (res.conversation_id && typeof setView === 'function') {
        setView('conversation', res.conversation_id);
      }
    } catch (err) {
      _log?.error?.(`template import failed: ${err.message}`);
      window.alert(`编队模板导入失败：${err.message || err}`);
    } finally {
      _setBusy(false);
    }
  }

  /** Midbar filter (全部 / 机器人 / 群组).
   *  机器人 is the EMPLOYEE LIST — every bot in the company, including ones
   *  never messaged (Grok Bot: "the main objects are Bots, not conversations").
   *  全部/群组 stay conversation-list filters. */
  function _bindConvFilter() {
    const bar = document.getElementById('conv-filter');
    if (!bar) return;
    bar.querySelectorAll('button[data-filter]').forEach((b) => {
      b.addEventListener('click', () => {
        bar.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        const f = b.dataset.filter || 'all';
        if (typeof window !== 'undefined') window.__onefleetConvFilter = f;
        _applyMidbarMode(f);
      });
    });
  }

  function _applyMidbarMode(filter) {
    const emp = document.getElementById('midbar-employees');
    const fleets = document.getElementById('midbar-fleets');
    const remote = document.getElementById('midbar-remote');
    const convNav = document.querySelector('.sidebar-conversation-nav');
    const midbar = document.getElementById('midbar');
    if (midbar) midbar.classList.toggle('mode-remote', filter === 'remote');
    if (fleets) fleets.hidden = filter !== 'fleets';
    if (remote) remote.hidden = filter !== 'remote';
    if (filter === 'remote') {
      if (emp) emp.hidden = true;
      // 远程模式中栏只留配置卡——微信消息入口在右栏管理页，不在这里重复。
      if (convNav) convNav.style.display = 'none';
      void _renderRemotePanel();
      return;
    }
    if (filter === 'fleets') {
      if (emp) emp.hidden = true;
      if (convNav) convNav.style.display = 'none';
      void _renderFleetCards();
      return;
    }
    if (filter === 'bots') {
      if (emp) emp.hidden = false;
      if (convNav) convNav.style.display = 'none';
      void _renderEmployeeList();
    } else {
      if (emp) emp.hidden = true;
      if (convNav) convNav.style.display = '';
      if (typeof renderConversationList === 'function') renderConversationList();
    }
  }

  /** Fleet cards — one per imported fleet (name, member count, conversation
   *  shortcut) from the registry; click opens the fleet's room. */
  async function _renderFleetCards() {
    const wrap = document.getElementById('midbar-fleet-cards');
    const empty = document.getElementById('midbar-fleets-empty');
    if (!wrap) return;
    wrap.innerHTML = '';
    if (empty) empty.style.display = '';
    try {
      const [res, convsRes] = await Promise.all([
        window.orkas.invoke('fleets.list', {}),
        window.orkas.invoke('conversations.list', {}).catch(() => ({ conversations: [] })),
      ]);
      // Defensive: a fleet whose room conversation was deleted is an orphan —
      // don't render a card that would navigate nowhere.
      const liveCids = new Set((convsRes.conversations || []).map((c) => c.conversation_id));
      const fleets = ((res && res.fleets) || []).filter((f) => f.conversation_id && liveCids.has(f.conversation_id));
      if (!fleets.length) return;
      if (empty) empty.style.display = 'none';
      for (const f of fleets) {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'fleet-card';
        card.innerHTML = `<span class="fleet-card-name">${_esc(f.name || f.fleet_id)}</span>`
          + `<span class="fleet-card-meta">${(f.agent_ids || []).length} 个机器人 · ${String(f.created_at || '').slice(0, 10)}</span>`;
        card.addEventListener('click', () => {
          if (f.conversation_id && typeof setView === 'function') setView('conversation', f.conversation_id);
        });
        wrap.appendChild(card);
      }
    } catch (err) {
      wrap.innerHTML = `<div class="conv-empty">${_esc(err.message || 'load failed')}</div>`;
    }
  }

  function _esc(t) {
    return String(t ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  /** Employee list — every agent as a row. Fleet tag from the fleet registry;
   *  click = useAgent (walk to that employee's desk and talk). */
  async function _renderEmployeeList() {
    const list = document.getElementById('midbar-employee-list');
    const empty = document.getElementById('midbar-employees-empty');
    if (!list) return;
    list.innerHTML = '';
    if (empty) empty.style.display = '';
    try {
      const [agentsRes, fleetsRes] = await Promise.all([
        window.orkas.invoke('agents.list', {}),
        window.orkas.invoke('fleets.list', {}).catch(() => ({ fleets: [] })),
      ]);
      const agents = (agentsRes.agents || []).filter((a) => a && a.agent_id && a.agent_id !== 'commander');
      const fleets = fleetsRes.fleets || [];
      const fleetByAgent = new Map();
      for (const f of fleets) for (const aid of f.agent_ids || []) fleetByAgent.set(aid, f);
      const rows = agents.map((a) => {
        const fleet = fleetByAgent.get(a.agent_id);
        const role = a.profile?.role || a.description_zh || '';
        return `<button type="button" class="employee-row" data-agent-id="${_esc(a.agent_id)}">
          <span class="employee-avatar">${_esc('🤖')}</span>
          <span class="employee-main">
            <span class="employee-name">${_esc(a.name || a.agent_id)}${fleet ? `<span class="employee-fleet">${_esc(fleet.name)}</span>` : ''}</span>
            <span class="employee-role">${_esc(role)}</span>
          </span>
          <span class="employee-go">›</span>
        </button>`;
      });
      list.innerHTML = rows.join('');
      if (empty) empty.style.display = rows.length ? 'none' : '';
      list.querySelectorAll('.employee-row').forEach((row) => {
        row.addEventListener('click', async () => {
          const agentId = row.dataset.agentId;
          if (!agentId) return;
          // IM 语义：对话列表里每一条都真的说过话。点击不落盘——
          //  已有该机器人的 DM（createConversation 绑定走 agent_id，
          //  composer 首聊走单成员 agent_ids）→ 直接进那张桌子；
          //  还没有 → useAgent 预选 recipient 进 composer，用户发出
          //  第一句话时 Orkas 才真正建会话。
          try {
            const list2 = await window.orkas.invoke('conversations.list', {});
            const existing = (list2.conversations || []).find((c) =>
              c.agent_id === agentId
              || (Array.isArray(c.agent_ids) && c.agent_ids.length === 1 && c.agent_ids[0] === agentId));
            if (existing && typeof setView === 'function') {
              setView('conversation', existing.conversation_id);
              return;
            }
          } catch (_) { /* prefill fallback below */ }
          if (typeof useAgent === 'function') useAgent(agentId);
        });
      });
    } catch (err) {
      list.innerHTML = `<div class="conv-empty">${_esc(err.message || 'load failed')}</div>`;
    }
  }

  /** Rail 消息 — land in the most recent conversation (IM apps open into the
   *  top thread); true first-run falls back to the composer. */
  function _bindRailMessages() {
    const btn = document.getElementById('rail-messages-btn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      if (typeof _markBootUserNavigation === 'function') _markBootUserNavigation();
      try {
        const res = await window.orkas.invoke('conversations.list', {});
        const convs = (res && res.conversations) || [];
        // No null initial: the first element seeds the accumulator (reading
        // updated_at off a null accumulator was the crash).
        const recent = convs.reduce((best, c) => {
          if (!best) return c;
          const ta = Date.parse(best.updated_at || best.created_at || '') || 0;
          const tb = Date.parse(c.updated_at || c.created_at || '') || 0;
          return tb > ta ? c : best;
        });
        if (recent && typeof setView === 'function') { setView('conversation', recent.conversation_id); return; }
      } catch (_) { /* fall through */ }
      if (typeof setView === 'function') setView('new-chat');
    });
  }

  /** First-run onboarding strip: show while the user has neither a model
   *  entry nor any conversation; hide permanently once either exists. */
  async function _refreshOnboarding() {
    const el = document.getElementById('new-chat-onboarding');
    if (!el) return;
    try {
      const convs = await window.orkas.invoke('conversations.list', {});
      const hasConv = Array.isArray(convs.conversations) && convs.conversations.length > 0;
      let hasModel = false;
      try {
        const entries = await window.orkas.invoke('auth.listComposerEntries', {});
        hasModel = Array.isArray(entries.entries) && entries.entries.length > 0;
      } catch (_) { /* keep showing step 1 */ }
      el.hidden = hasConv || hasModel;
      const step1 = el.querySelector('[data-step="1"]');
      if (step1) step1.classList.toggle('is-done', hasModel);
      const step3 = el.querySelector('[data-step="3"]');
      if (step3) step3.classList.toggle('is-done', hasConv);
    } catch (_) { /* list unavailable — keep hidden default */ }
  }

  function _bind() {
    _btn()?.addEventListener('click', () => _fileInput()?.click());
    _fileInput()?.addEventListener('change', (e) => { void _onFileChosen(e); });
    _bindConvFilter();
    _bindRailMessages();
    document.getElementById('onboarding-model-btn')
      ?.addEventListener('click', () => { if (typeof setView === 'function') setView('settings'); });
    document.getElementById('onboarding-template-btn')
      ?.addEventListener('click', () => _fileInput()?.click());
    // Rail 编队 — fleets mode in the midbar (cards + import). From tool views
    // setView() has hidden the midbar; reveal it and own the rail highlight
    // (same contract as the remote button below).
    document.getElementById('rail-fleets-btn')?.addEventListener('click', () => {
      if (typeof _markBootUserNavigation === 'function') _markBootUserNavigation();
      const midbar = document.getElementById('midbar');
      if (midbar) midbar.hidden = false;
      document.getElementById('conv-filter')?.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
      document.getElementById('rail-fleets-btn')?.classList.add('active');
      document.getElementById('rail-messages-btn')?.classList.remove('active');
      document.getElementById('rail-remote-btn')?.classList.remove('active');
      _applyMidbarMode('fleets');
    });
    document.getElementById('midbar-import-template-btn')
      ?.addEventListener('click', () => _fileInput()?.click());
    // Rail 远程 — a real view now: setView('remote') activates panel-remote,
    // keeps the midbar visible with the compact card, and owns the rail
    // highlight. setView dispatches 'remote-view-enter' for the refresh below.
    document.getElementById('rail-remote-btn')?.addEventListener('click', () => {
      if (typeof _markBootUserNavigation === 'function') _markBootUserNavigation();
      if (typeof setView === 'function') { setView('remote'); return; }
      // Fallback: setView unavailable — at least flip the midbar into remote mode.
      const midbar = document.getElementById('midbar');
      if (midbar) midbar.hidden = false;
      document.getElementById('conv-filter')?.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
      document.getElementById('rail-remote-btn')?.classList.add('active');
      document.getElementById('rail-messages-btn')?.classList.remove('active');
      _applyMidbarMode('remote');
    });
    _bindRemotePanel();
    void _refreshOnboarding();
  }


  // ── 远程（Remote channels）──────────────────────────────────────────────
  // 微信 iLink 渠道卡：未连接 → 扫码 → 已连接（绑定值班机器人）。协议轮询
  // 与消息注入都在主进程，这里只做登录会话与绑定表单。

  // 双表面：bar = 中栏紧凑卡（mode-remote 时可见），view = 右栏管理页
  // (panel-remote)。状态渲染/登录轮询驱动同一份逻辑，按 scope 取元素，
  // 两个表面始终同步——用户看哪个都一致。
  const REMOTE_SCOPES = {
    bar: {
      state: 'remote-weixin-state', body: 'remote-weixin-body',
      qr: 'remote-weixin-qr', qrImg: 'remote-weixin-qr-img',
      qrStatus: 'remote-weixin-qr-status', error: 'remote-weixin-error',
      bound: 'remote-weixin-bound', agent: 'remote-weixin-agent',
      connect: 'remote-weixin-connect', refresh: 'remote-weixin-qr-refresh',
      disconnect: 'remote-weixin-disconnect',
    },
    view: {
      state: 'remote-view-state', body: 'remote-view-body',
      qr: 'remote-view-qr', qrImg: 'remote-view-qr-img',
      qrStatus: 'remote-view-qr-status', error: 'remote-view-error',
      bound: 'remote-view-bound', agent: 'remote-view-agent',
      connect: 'remote-view-connect', refresh: 'remote-view-qr-refresh',
      disconnect: 'remote-view-disconnect',
    },
  };

  function _remoteEls(scope) {
    const ids = REMOTE_SCOPES[scope];
    const els = {};
    for (const [key, id] of Object.entries(ids)) els[key] = document.getElementById(id);
    return els;
  }

  function _setRemoteError(scope, message) {
    const { error: errorEl } = _remoteEls(scope);
    if (!errorEl) return;
    errorEl.textContent = message || '';
    errorEl.hidden = !message;
  }

  let _remotePollTimer = null;
  let _remoteLastState = null;

  async function _renderRemotePanel() {
    let st;
    try { st = await window.orkas.invoke('channels.status', {}); } catch (_) { return; }
    _remoteLastState = st;
    const connected = !!(st && st.connected);
    const stalled = connected && st.looping === false;
    for (const scope of Object.keys(REMOTE_SCOPES)) {
      const { state: stateEl, body: bodyEl, qr: qrEl, bound: boundEl, error: errorEl } = _remoteEls(scope);
      if (!stateEl || !bodyEl) continue;
      stateEl.textContent = connected
        ? (stalled ? (i18nText('remote.state_stalled') || '已断开') : (i18nText('remote.state_on') || '已连接'))
        : (i18nText('remote.state_off') || '未连接');
      stateEl.classList.toggle('is-on', connected && !stalled);
      // 已连接但轮询循环没在跑（凭据失效自愈失败）也如实展示为断开。
      bodyEl.hidden = connected;
      qrEl.hidden = true;
      boundEl.hidden = !connected;
      if (errorEl) { errorEl.hidden = true; errorEl.textContent = ''; }
    }
    if (connected) await _fillRemoteAgentSelect(st.account && st.account.agentId);
    void _renderRemoteConvos(st);
  }

  async function _fillRemoteAgentSelect(selectedId) {
    let agents = [];
    try { const res = await window.orkas.invoke('channels.agents', {}); agents = (res && res.agents) || []; } catch (_) {}
    for (const scope of Object.keys(REMOTE_SCOPES)) {
      const sel = _remoteEls(scope).agent;
      if (!sel) continue;
      sel.innerHTML = '';
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = i18nText('remote.bind_placeholder') || '选择一个机器人…';
      sel.appendChild(placeholder);
      for (const a of agents) {
        const opt = document.createElement('option');
        opt.value = a.agent_id || a.id || '';
        opt.textContent = a.name || a.agent_id || a.id || '';
        sel.appendChild(opt);
      }
      sel.value = selectedId || '';
    }
  }

  /** 微信消息入口 — 值班机器人的 DM 会话（微信入站都落在它的 DM 里）。
   *  点击即进聊天：配置面在这里，聊点进去聊。 */
  async function _renderRemoteConvos(st) {
    const wrap = document.getElementById('remote-view-convos');
    const empty = document.getElementById('remote-view-convos-empty');
    if (!wrap) return;
    wrap.innerHTML = '';
    const agentId = st && st.account && st.account.agentId;
    if (!agentId) { if (empty) empty.style.display = ''; return; }
    try {
      const res = await window.orkas.invoke('conversations.list', {});
      const convs = (res.conversations || [])
        .filter((c) => c.agent_id === agentId
          || (Array.isArray(c.agent_ids) && c.agent_ids.includes(agentId)))
        .sort((a, b) => {
          const ta = Date.parse(a.updated_at || a.created_at || '') || 0;
          const tb = Date.parse(b.updated_at || b.created_at || '') || 0;
          return tb - ta;
        })
        .slice(0, 6);
      const hasAny = convs.length > 0;
      if (empty) empty.style.display = hasAny ? 'none' : '';
      for (const c of convs) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'remote-convo-row';
        const when = String(c.updated_at || c.created_at || '').slice(5, 16).replace('T', ' ');
        row.innerHTML = `<span class="remote-convo-name">${_esc(c.title || c.conversation_id)}</span>`
          + `<span class="remote-convo-time">${_esc(when)}</span>`;
        row.addEventListener('click', () => {
          if (typeof setView === 'function') setView('conversation', c.conversation_id);
        });
        wrap.appendChild(row);
      }
    } catch (_) { if (empty) empty.style.display = ''; }
  }

  async function _beginRemoteLogin() {
    let session;
    try {
      session = await window.orkas.invoke('channels.beginLogin', {});
    } catch (err) {
      for (const scope of Object.keys(REMOTE_SCOPES)) {
        _setRemoteError(scope, `⚠️ ${err && err.message ? err.message : '登录会话发起失败'}`);
      }
      return;
    }
    for (const scope of Object.keys(REMOTE_SCOPES)) {
      const { body: bodyEl, qr: qrEl, qrImg: imgEl, qrStatus: qrStatusEl, error: errorEl } = _remoteEls(scope);
      if (imgEl && session.qrDataUrl) imgEl.src = session.qrDataUrl;
      if (qrStatusEl) qrStatusEl.textContent = i18nText('remote.state_scanning') || '等待扫码…';
      if (qrEl) qrEl.hidden = false;
      if (bodyEl) bodyEl.hidden = true;
      if (errorEl) { errorEl.hidden = true; errorEl.textContent = ''; }
    }
    _pollRemoteLogin(session.intervalMs || 3000, session.expiresAt || Date.now() + 120000);
  }

  function _bindRemotePanel() {
    const bind = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
    const change = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('change', fn); };
    for (const scope of Object.keys(REMOTE_SCOPES)) {
      const ids = REMOTE_SCOPES[scope];
      bind(ids.connect, () => { void _beginRemoteLogin(); });
      bind(ids.refresh, () => { void _beginRemoteLogin(); });
      bind(ids.disconnect, async () => {
        try { await window.orkas.invoke('channels.disconnect', {}); } catch (_) {}
        void _renderRemotePanel();
      });
      change(ids.agent, async (e) => {
        const agentId = e.target && e.target.value;
        if (!agentId) return;
        try {
          await window.orkas.invoke('channels.bindAgent', { agent_id: agentId });
          for (const s2 of Object.keys(REMOTE_SCOPES)) _setRemoteError(s2, '');
          const st = _remoteLastState;
          void _renderRemoteConvos(st);
        } catch (err) {
          for (const s2 of Object.keys(REMOTE_SCOPES)) {
            _setRemoteError(s2, `⚠️ ${err && err.message ? err.message : '绑定失败'}`);
          }
        }
      });
    }
    window.addEventListener('remote-view-enter', () => { void _renderRemotePanel(); });
  }

  function _pollRemoteLogin(intervalMs, expiresAt) {
    if (_remotePollTimer) clearInterval(_remotePollTimer);
    _remotePollTimer = setInterval(async () => {
      if (Date.now() > expiresAt) {
        clearInterval(_remotePollTimer); _remotePollTimer = null;
        for (const scope of Object.keys(REMOTE_SCOPES)) {
          const { qrStatus: qrStatusEl } = _remoteEls(scope);
          if (qrStatusEl) qrStatusEl.textContent = i18nText('remote.state_expired') || '二维码已过期，请刷新';
        }
        return;
      }
      let res;
      try { res = await window.orkas.invoke('channels.pollLogin', {}); } catch (_) { return; }
      if (res && res.status === 'success') {
        clearInterval(_remotePollTimer); _remotePollTimer = null;
        void _renderRemotePanel();
        return;
      }
      const text = (res && res.status === 'scanned') ? (i18nText('remote.state_scanned') || '已扫码 — 请在手机上确认')
        : (res && res.status === 'expired') ? (i18nText('remote.state_expired') || '二维码已过期，请刷新')
        : (res && res.status === 'error') ? ((res && res.message) || '登录失败，请重试')
        : null;
      if (!text) return;
      if (res && (res.status === 'expired' || res.status === 'error')) {
        clearInterval(_remotePollTimer); _remotePollTimer = null;
      }
      for (const scope of Object.keys(REMOTE_SCOPES)) {
        const { qrStatus: qrStatusEl } = _remoteEls(scope);
        if (qrStatusEl) qrStatusEl.textContent = text;
      }
    }, intervalMs);
  }

  function i18nText(key) {
    try {
      const boot = window.__orkasI18nBoot;
      const table = boot && boot.tables && boot.tables[boot.lang];
      return (table && typeof table[key] === 'string') ? table[key] : '';
    } catch (_) { return ''; }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _bind);
  } else {
    _bind();
  }
})();
