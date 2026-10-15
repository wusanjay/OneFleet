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
    const convNav = document.querySelector('.sidebar-conversation-nav');
    if (fleets) fleets.hidden = filter !== 'fleets';
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
    // Rail 编队 — fleets mode in the midbar (cards + import).
    document.getElementById('rail-fleets-btn')?.addEventListener('click', () => {
      if (typeof _markBootUserNavigation === 'function') _markBootUserNavigation();
      document.getElementById('conv-filter')?.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
      _applyMidbarMode('fleets');
    });
    document.getElementById('midbar-import-template-btn')
      ?.addEventListener('click', () => _fileInput()?.click());
    void _refreshOnboarding();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _bind);
  } else {
    _bind();
  }
})();
