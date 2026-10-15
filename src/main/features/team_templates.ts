/**
 * team_templates.ts — 编队模板 (Team Template) import / export.
 *
 * A team template is a portable YAML file that describes a complete
 * multi-agent group: the members (agents), their personas, and the first
 * task to run. Import turns one YAML file into a working group chat with
 * zero manual configuration; export turns an existing conversation's
 * member roster back into a template. This is the fleet-template layer:
 * the product's core asset is a library of these files.
 *
 * Design constraints (deliberate):
 *   - Composition only. Everything here goes through existing feature
 *     facades (`agents.createCustomAgent`, `chats.createConversation`,
 *     `group_chat.send`, `auth.addApiKeyEntry`); no bus, session, or
 *     storage internals are touched, so a template import behaves exactly
 *     like a user performing the same steps through the UI.
 *   - Agents join the group the same way humans add them: the welcome
 *     task text @-mentions every member display name, and the existing
 *     auto-join path (router mention parse → `state.addMember`) does the
 *     rest. No group-internal state is written directly.
 *   - One YAML ⇄ one conversation. Re-importing the same file creates a
 *     NEW team (agents and conversation); there is no upsert. Idempotent
 *     team provisioning is a future concern (needs template identity).
 *
 * YAML schema (v1) — see `docs/` example `solo-growth.yaml`:
 *
 *   team:
 *     id: solo-growth            # template slug ([a-z0-9-], informational)
 *     name: 一人公司增长组         # becomes the conversation title
 *     category: creation          # marketplace category code (optional)
 *     description: ...            # roster description (optional)
 *   model:                        # optional — app-level chat model entry
 *     provider: zai               # provider id from the provider catalog
 *     model: glm-5.3-flash        # model id offered by that provider
 *     api_key: sk-...             # inline key XOR api_key_env
 *     api_key_env: GLM_API_KEY    # env var read in the main process
 *   members:                      # 1–12 entries
 *     - id: researcher            # template-internal slug (informational)
 *       name: 调研员               # display name; ALSO the @mention handle
 *       icon: search              # optional avatar icon id
 *       color: sky                # optional avatar color id
 *       role: ...                 # ≤140 chars — one-line duty statement
 *       dispatch: ...             # ≤520 chars — when to route work here
 *       instructions: [...]       # runtime guidance → agent `standards`
 *       notes: [...]              # display-only expertise → `knowhow`
 *       skills: [web-search]      # optional skill refs (must resolve)
 *   welcome_task:
 *     text: |                     # first user message in the group;
 *       ...                       # member @mentions are appended automatically
 *   acceptance:                   # optional; rendered into the welcome text
 *     - 每条结论附来源链接
 */

import YAML from 'yaml';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { userFleetsFile } from '../paths';

import { createLogger } from '../logger';
import { safeId, genId12, readJson, writeJson } from '../storage';
import { nowIso } from '../storage';
import * as avatars from './avatars';
import * as agents from './agents';
import * as auth from './auth';
import * as chats from './chats';
import * as groupChat from './group_chat';

const log = createLogger('team_templates');

export const TEAM_TEMPLATE_SCHEMA_VERSION = 1;

export const TEAM_TEMPLATE_MAX_MEMBERS = 12;

// House limits mirrored from agents.ts `normalizeAgentProfile` — the import
// validates against the same budgets the native form enforces, so a template
// that passes here never trips mid-import on a profile limit.
const ROLE_MAX_CHARS = 140;
const DISPATCH_MAX_CHARS = 520;
const PROFILE_LIST_MAX_ITEMS = 16;
const PROFILE_ITEM_MAX_CHARS = 220;

export interface TeamTemplateModel {
  provider: string;
  model: string;
  api_key?: string;
  api_key_env?: string;
}

export interface TeamTemplateMember {
  id: string;
  name: string;
  icon?: string;
  color?: string;
  role?: string;
  dispatch?: string;
  instructions?: string[];
  notes?: string[];
  skills?: string[];
}

export interface TeamTemplate {
  team: {
    id: string;
    name: string;
    category?: string;
    description?: string;
  };
  model?: TeamTemplateModel;
  members: TeamTemplateMember[];
  welcome_task: { text: string };
  acceptance?: string[];
}

export interface ParsedTeamTemplate {
  template: TeamTemplate;
  /** Non-fatal notes for the importer UI (unknown icon fell back, etc.). */
  warnings: string[];
}

// ── Validation ───────────────────────────────────────────────────────────

function _str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** Template slugs are ASCII-only ([a-z0-9-]); CJK display names slug to a
 *  random id — the slug is informational, the display name is the handle. */
function _slug(name: string): string {
  const ascii = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return /^[a-z0-9][a-z0-9-]*$/.test(ascii) ? ascii : `team-${genId12()}`;
}

function _strList(v: unknown, field: string, warnings: string[]): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) throw new Error(`team template field "${field}" must be a list`);
  const out = v.map((x) => _str(x)).filter(Boolean);
  if (out.length > PROFILE_LIST_MAX_ITEMS) throw new Error(`team template field "${field}" allows at most ${PROFILE_LIST_MAX_ITEMS} entries`);
  for (const item of out) {
    if (item.length > PROFILE_ITEM_MAX_CHARS) {
      throw new Error(`team template field "${field}" entries are limited to ${PROFILE_ITEM_MAX_CHARS} chars`);
    }
  }
  if (out.length !== v.length) warnings.push(`${field}: empty entries dropped`);
  return out;
}

/**
 * Parse and validate a template YAML document. Throws a plain Error with a
 * precise message on any structural violation; collects non-fatal fallbacks
 * (unknown icon/color) into `warnings` instead of failing the import.
 */
export function parseTeamTemplateYaml(text: string): ParsedTeamTemplate {
  const warnings: string[] = [];
  let doc: unknown;
  try {
    doc = YAML.parse(text);
  } catch (err) {
    throw new Error(`team template is not valid YAML: ${(err as Error).message}`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('team template must be a YAML mapping');
  }
  const root = doc as Record<string, unknown>;

  const teamRaw = root.team;
  if (!teamRaw || typeof teamRaw !== 'object' || Array.isArray(teamRaw)) {
    throw new Error('team template requires a "team:" block');
  }
  const team = teamRaw as Record<string, unknown>;
  const teamName = _str(team.name);
  if (!teamName) throw new Error('team template requires team.name');
  const teamId = _str(team.id).toLowerCase() || _slug(teamName);
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(teamId)) {
    throw new Error('team.id must match [a-z0-9-] (max 64 chars)');
  }

  const modelRaw = root.model as Record<string, unknown> | undefined;
  let model: TeamTemplateModel | undefined;
  if (modelRaw) {
    const provider = _str(modelRaw.provider);
    const modelId = _str(modelRaw.model);
    if (!provider || !modelId) throw new Error('model block requires provider and model');
    const apiKey = _str(modelRaw.api_key);
    const apiKeyEnv = _str(modelRaw.api_key_env);
    if (apiKey && apiKeyEnv) throw new Error('model.api_key and model.api_key_env are mutually exclusive');
    if (!apiKey && !apiKeyEnv) warnings.push('model: no api_key supplied — the existing chat model entry (if any) is kept');
    model = {
      provider,
      model: modelId,
      ...(apiKey ? { api_key: apiKey } : {}),
      ...(apiKeyEnv ? { api_key_env: apiKeyEnv } : {}),
    };
  }

  const membersRaw = root.members;
  if (!Array.isArray(membersRaw) || membersRaw.length === 0) {
    throw new Error('team template requires at least one member');
  }
  if (membersRaw.length > TEAM_TEMPLATE_MAX_MEMBERS) {
    throw new Error(`team template allows at most ${TEAM_TEMPLATE_MAX_MEMBERS} members (group chat room cap)`);
  }
  const seenNames = new Set<string>();
  const members: TeamTemplateMember[] = membersRaw.map((raw, idx) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`members[${idx}] must be a mapping`);
    }
    const m = raw as Record<string, unknown>;
    const name = _str(m.name);
    if (!name) throw new Error(`members[${idx}].name is required`);
    if (seenNames.has(name)) throw new Error(`duplicate member name "${name}" — @mention handles must be unique`);
    seenNames.add(name);
    const icon = _str(m.icon);
    if (icon && !avatars.isKnownIcon(icon)) {
      warnings.push(`members[${idx}] ("${name}"): unknown icon "${icon}" — using default`);
    }
    const color = _str(m.color);
    if (color && !avatars.isKnownColor(color)) {
      warnings.push(`members[${idx}] ("${name}"): unknown color "${color}" — using default`);
    }
    const role = _str(m.role);
    if (role.length > ROLE_MAX_CHARS) throw new Error(`members[${idx}].role is limited to ${ROLE_MAX_CHARS} chars`);
    const dispatch = _str(m.dispatch);
    if (dispatch.length > DISPATCH_MAX_CHARS) throw new Error(`members[${idx}].dispatch is limited to ${DISPATCH_MAX_CHARS} chars`);
    const skills = _strList(m.skills, `members[${idx}].skills`, warnings);
    return {
      id: (_str(m.id).toLowerCase() || _slug(name)).slice(0, 64),
      name,
      ...(icon && avatars.isKnownIcon(icon) ? { icon } : {}),
      ...(color && avatars.isKnownColor(color) ? { color } : {}),
      ...(role ? { role } : {}),
      ...(dispatch ? { dispatch } : {}),
      instructions: _strList(m.instructions, `members[${idx}].instructions`, warnings),
      notes: _strList(m.notes, `members[${idx}].notes`, warnings),
      ...(skills && skills.length ? { skills } : {}),
    };
  });

  const welcomeRaw = root.welcome_task;
  if (!welcomeRaw || typeof welcomeRaw !== 'object' || Array.isArray(welcomeRaw)) {
    throw new Error('team template requires a "welcome_task:" block');
  }
  const welcomeText = _str((welcomeRaw as Record<string, unknown>).text);
  if (!welcomeText) throw new Error('welcome_task.text is required');

  const acceptance = _strList(root.acceptance, 'acceptance', warnings);

  return {
    template: {
      team: {
        id: teamId,
        name: teamName,
        category: _str(team.category) || undefined,
        description: _str(team.description) || undefined,
      },
      ...(model ? { model } : {}),
      members,
      welcome_task: { text: welcomeText },
      ...(acceptance && acceptance.length ? { acceptance } : {}),
    },
    warnings,
  };
}

// ── Welcome text assembly ────────────────────────────────────────────────

/** The welcome message is the only channel that (a) joins the agents into
 *  the room and (b) kicks off real work, so it is assembled deterministically:
 *  explicit @mentions first (auto-join), the task body, then the acceptance
 *  list as a visible contract. Members are told they were set up by the
 *  template so nobody re-introduces themselves from zero. */
export function buildWelcomeText(template: TeamTemplate): string {
  const mentions = template.members.map((m) => `@${m.name}`).join(' ');
  const lines: string[] = [];
  lines.push(`${mentions} 编队已就位。`);
  lines.push('');
  lines.push(template.welcome_task.text.trim());
  if (template.acceptance?.length) {
    lines.push('');
    lines.push('验收标准：');
    for (const item of template.acceptance) lines.push(`- ${item}`);
  }
  return lines.join('\n');
}

// ── Model entry ──────────────────────────────────────────────────────────

async function _ensureModelEntry(model: TeamTemplateModel): Promise<{ entryId: string; created: boolean } | { error: string }> {
  const key = model.api_key
    ?? (model.api_key_env ? (process.env[model.api_key_env] ?? '').trim() : '');
  if (!key) return { error: `no API key for ${model.provider} (set model.api_key or ${model.api_key_env ? `env ${model.api_key_env}` : 'model.api_key_env'})` };
  try {
    // Re-use an existing entry for the same (provider, model) when one is
    // already selected — importing a template twice must not pile up profiles.
    const existing = await auth.listComposerEntries();
    const match = existing.entries.find((e) => e.provider === model.provider && e.model === model.model);
    if (match) {
      await auth.selectEntry(match.entryId, model.model);
      return { entryId: match.entryId, created: false };
    }
    const added = await auth.addApiKeyEntry(model.provider, model.model, key, `team-template ${model.provider}`);
    await auth.selectEntry(added.entryId, model.model);
    return { entryId: added.entryId, created: true };
  } catch (err) {
    return { error: `model entry for ${model.provider}/${model.model} failed: ${(err as Error).message}` };
  }
}

// ── Import ───────────────────────────────────────────────────────────────

export interface FleetRecord {
  fleet_id: string;
  name: string;
  template_id: string;
  agent_ids: string[];
  conversation_id: string;
  created_at: string;
  updated_at: string;
}

async function readFleetRegistry(userId: string): Promise<Record<string, FleetRecord>> {
  try {
    const list = await readJson<FleetRecord[]>(userFleetsFile(userId));
    return (Array.isArray(list) ? list : []).reduce<Record<string, FleetRecord>>((acc, f) => {
      if (f && f.fleet_id) acc[f.fleet_id] = f;
      return acc;
    }, {});
  } catch {
    return {};
  }
}

async function writeFleetRegistry(userId: string, records: Record<string, FleetRecord>): Promise<void> {
  fs.mkdirSync(path.dirname(userFleetsFile(userId)), { recursive: true });
  writeJson(userFleetsFile(userId), Object.values(records));
}

/** Upsert one fleet record (import creates; re-import of the same template
 *  id replaces that fleet's record). Best-effort: the import itself must not
 *  fail because bookkeeping did. */
async function upsertFleetRecord(userId: string, record: FleetRecord): Promise<void> {
  try {
    const records = await readFleetRegistry(userId);
    records[record.fleet_id] = record;
    await writeFleetRegistry(userId, records);
  } catch (err) {
    log.warn(`fleet registry write failed: ${(err as Error).message}`);
  }
}

export async function listFleets(userId: string): Promise<FleetRecord[]> {
  return Object.values(await readFleetRegistry(userId)).sort((a, b) =>
    (b.updated_at || '').localeCompare(a.updated_at || ''),
  );
}

export interface ImportTeamTemplateResult {
  ok: true;
  conversation_id: string;
  team_id: string;
  team_name: string;
  members: Array<{ template_id: string; name: string; agent_id: string }>;
  model_entry: { entryId: string; created: boolean } | null;
  model_error: string | null;
  warnings: string[];
}

/**
 * Import a template: parse → (optional) model entry → create agents →
 * create the conversation → send the welcome task. Agent creation is not
 * transactional: if member 3 of 5 fails, members 1–2 stay (they are valid
 * user-visible agents), and the error names the failed member. Re-running
 * the import creates a fresh team; clean up stray agents from the AI 团队 page.
 */
export async function importTeamTemplate(
  userId: string,
  yamlText: string,
): Promise<ImportTeamTemplateResult> {
  const { template, warnings } = parseTeamTemplateYaml(yamlText);

  let modelEntry: { entryId: string; created: boolean } | null = null;
  let modelError: string | null = null;
  if (template.model) {
    const outcome = await _ensureModelEntry(template.model);
    if ('error' in outcome) {
      // Non-fatal: the team can still be provisioned; the user just has to
      // pick a model in the composer before the welcome turn will run.
      modelError = outcome.error;
      warnings.push(modelError);
      log.warn(`template ${template.team.id}: ${outcome.error}`);
    } else {
      modelEntry = outcome;
    }
  }

  const created: Array<{ template_id: string; name: string; agent_id: string }> = [];
  try {
    // Idempotent re-import: an agent with the same display name is UPDATED in
    // place (profile/skills) instead of failing the whole import — re-running
    // a template refreshes the team. Name-uniqueness is the match key, which
    // is also what @mention routing resolves by.
    const existingByName = new Map<string, { agent_id: string }>();
    for (const a of await agents.listAgents()) {
      if (a && a.name) existingByName.set(a.name, a);
    }
    for (const member of template.members) {
      const guidance = {
        ...(member.role ? { role: member.role } : {}),
        ...(member.dispatch ? { dispatch: member.dispatch } : {}),
      };
      const existing = existingByName.get(member.name);
      let agentId: string;
      if (existing) {
        await agents.updateCustomAgent(existing.agent_id, {
          ...(member.role || member.name ? { description_zh: member.role || member.name } : {}),
          ...(template.team.category ? { category: template.team.category } : {}),
          profile: guidance,
          ...(member.notes?.length ? { knowhow: member.notes } : {}),
          ...(member.instructions?.length ? { standards: member.instructions } : {}),
          ...(member.icon ? { icon: member.icon } : {}),
          ...(member.color ? { color: member.color } : {}),
        });
        agentId = existing.agent_id;
        log.info(`template ${template.team.id}: agent ${agentId} (${member.name}) updated`);
      } else {
        const agent = await agents.createCustomAgent({
          name: member.name,
          description_zh: member.role || member.name,
          category: template.team.category,
          profile: guidance,
          // Guidance lists go through the TOP-LEVEL options, not profile:
          // createCustomAgent's normalizeAgentProfile prefers the outer keys
          // whenever they exist, and it always calls with both keys present —
          // profile-embedded lists would be shadowed by undefined (observed
          // 2026-10-14: profile-only import produced agents without guidance).
          ...(member.notes?.length ? { knowhow: member.notes } : {}),
          ...(member.instructions?.length ? { standards: member.instructions } : {}),
          ...(member.icon ? { icon: member.icon } : {}),
          ...(member.color ? { color: member.color } : {}),
          ...(member.skills?.length ? { skill_list: member.skills } : {}),
          interactive: true,
        });
        if (!agent) throw new Error(`failed to create agent "${member.name}"`);
        agentId = agent.agent_id;
      }
      created.push({ template_id: member.id, name: member.name, agent_id: agentId });
      log.info(`template ${template.team.id}: agent ${agentId} (${member.name}) ready`);
    }

    const conv = await chats.createConversation(userId, {
      title: template.team.name,
    });

    const text = buildWelcomeText(template);
    const sent = await groupChat.send({ userId, cid: conv.conversation_id, text });
    if (!sent.ok) throw new Error(`welcome task failed: ${sent.error ?? 'unknown error'}`);

    upsertFleetRecord(userId, {
      fleet_id: template.team.id,
      name: template.team.name,
      template_id: template.team.id,
      agent_ids: created.map((m) => m.agent_id),
      conversation_id: conv.conversation_id,
      created_at: nowIso(),
      updated_at: nowIso(),
    });

    log.info(`template ${template.team.id}: team imported, cid=${conv.conversation_id}, members=${created.length}`);
    return {
      ok: true,
      conversation_id: conv.conversation_id,
      team_id: template.team.id,
      team_name: template.team.name,
      members: created,
      model_entry: modelEntry,
      model_error: modelError,
      warnings,
    };
  } catch (err) {
    log.error(`template ${template.team.id} import failed after ${created.length} member(s): ${(err as Error).message}`);
    throw err;
  }
}

// ── Export ───────────────────────────────────────────────────────────────

/**
 * Export a conversation's non-reserved members back into a template YAML.
 * Commander/user are dropped; every agent actor becomes a member with its
 * live profile (role / dispatch / knowhow→notes / standards→instructions).
 * The welcome task is reconstructed from the conversation's first user
 * message minus the generated mention prologue, so the roundtrip
 * export→import reproduces a working team.
 */
export async function exportTeamTemplateFromConversation(
  userId: string,
  cid: string,
  overrides: { teamId?: string; teamName?: string } = {},
): Promise<{ yaml: string; template: TeamTemplate }> {
  if (!safeId(cid)) throw new Error('invalid cid');
  const { readMembers } = await import('./group_chat/state');
  const members = await readMembers(userId, cid);
  const actorMembers = (members?.actors ?? []).filter((a) => a.kind === 'agent');
  if (!actorMembers.length) throw new Error('conversation has no agent members to export');

  const conv = await chats.getConversation(userId, cid);
  const teamName = overrides.teamName || conv?.title || cid;

  const outMembers: TeamTemplateMember[] = [];
  for (const actor of actorMembers) {
    const agent = await agents.getAgent(actor.id);
    if (!agent) continue;
    outMembers.push({
      id: _slug(agent.name),
      name: agent.name,
      ...(agent.icon ? { icon: agent.icon } : {}),
      ...(agent.color ? { color: agent.color } : {}),
      ...(agent.profile?.role ? { role: agent.profile.role } : {}),
      ...(agent.profile?.dispatch ? { dispatch: agent.profile.dispatch } : []),
      ...(agent.profile?.knowhow?.length ? { notes: agent.profile.knowhow } : {}),
      ...(agent.profile?.standards?.length ? { instructions: agent.profile.standards } : {}),
    } as TeamTemplateMember);
  }

  // First user message minus the assembled prologue = the original task body.
  let welcomeText = `在「${teamName}」里继续协作`;
  try {
    const msgs = await chats.getMessages(userId, cid, 50);
    const firstUser = msgs.find((m) => m.from === 'user' && m.text?.trim());
    const raw = _str(firstUser?.text);
    if (raw) welcomeText = raw;
  } catch (err) {
    log.warn(`export ${cid}: could not read first user message (${(err as Error).message})`);
  }

  const template: TeamTemplate = {
    team: {
      id: overrides.teamId || _slug(teamName),
      name: teamName,
    },
    members: outMembers,
    welcome_task: { text: welcomeText },
  };
  return { yaml: stringifyTeamTemplate(template), template };
}

/** Stable YAML rendering used by export (member order preserved). */
export function stringifyTeamTemplate(template: TeamTemplate): string {
  return YAML.stringify(template, { lineWidth: 100 });
}

/** Read a template from disk (file picker path → text). */
export function readTeamTemplateFile(filePath: string): string {
  const text = fs.readFileSync(filePath, 'utf8');
  if (!text.trim()) throw new Error('template file is empty');
  return text;
}
