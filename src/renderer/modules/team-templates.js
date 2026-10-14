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

  /** Workbench group (collapsed toolbox) — persists open/closed per machine. */
  function _bindWorkbench() {
    const toggle = document.getElementById('workbench-toggle');
    const actions = document.getElementById('workbench-actions');
    if (!toggle || !actions) return;
    const apply = (open) => {
      toggle.setAttribute('aria-expanded', String(open));
      actions.hidden = !open;
    };
    let saved = null;
    try { saved = localStorage.getItem('onefleet.workbench'); } catch (_) {}
    apply(saved === 'open');
    toggle.addEventListener('click', () => {
      const open = toggle.getAttribute('aria-expanded') !== 'true';
      apply(open);
      try { localStorage.setItem('onefleet.workbench', open ? 'open' : 'closed'); } catch (_) {}
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
    _bindWorkbench();
    document.getElementById('onboarding-model-btn')
      ?.addEventListener('click', () => { if (typeof setView === 'function') setView('settings'); });
    document.getElementById('onboarding-template-btn')
      ?.addEventListener('click', () => _fileInput()?.click());
    void _refreshOnboarding();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _bind);
  } else {
    _bind();
  }
})();
