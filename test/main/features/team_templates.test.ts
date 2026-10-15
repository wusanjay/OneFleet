import { describe, it, expect } from 'vitest';
import {
  parseTeamTemplateYaml,
  buildWelcomeText,
  stringifyTeamTemplate,
} from '../../../src/main/features/team_templates';

const MINIMAL = `
team:
  id: t1
  name: 测试编队
members:
  - id: a
    name: 写手
welcome_task:
  text: 开始工作
`;

describe('team_templates.parse', () => {
  it('parses a minimal valid template', () => {
    const { template, warnings } = parseTeamTemplateYaml(MINIMAL);
    expect(template.team.id).toBe('t1');
    expect(template.team.name).toBe('测试编队');
    expect(template.members).toHaveLength(1);
    expect(template.members[0].name).toBe('写手');
    expect(warnings).toEqual([]);
  });

  it('rejects missing team block / members / welcome task', () => {
    expect(() => parseTeamTemplateYaml('team:\n  name: x\n')).toThrow(/member/);
    expect(() => parseTeamTemplateYaml('members: []\nwelcome_task:\n  text: x\n')).toThrow(/team/);
    expect(() => parseTeamTemplateYaml(MINIMAL.replace('text: 开始工作', ''))).toThrow(/welcome_task/);
  });

  it('rejects duplicate member names (mention handles must be unique)', () => {
    const dup = MINIMAL.replace('name: 写手\nwelcome_task', 'name: 写手\n  - id: b\n    name: 写手\nwelcome_task')
      .replace('welcome_task', '  - id: c\n    name: 其他\nwelcome_task');
    expect(() => parseTeamTemplateYaml(dup)).toThrow(/duplicate member name/);
  });

  it('enforces profile budgets (role 140, list item 220)', () => {
    const longRole = 'x'.repeat(141);
    expect(() => parseTeamTemplateYaml(
      MINIMAL.replace('name: 写手', `name: 写手\n    role: ${longRole}`),
    )).toThrow(/role/);
    const longItem = 'y'.repeat(221);
    expect(() => parseTeamTemplateYaml(
      MINIMAL.replace('name: 写手', `name: 写手\n    instructions:\n      - ${longItem}`),
    )).toThrow(/instructions/);
  });

  it('caps members at the group room limit', () => {
    const members = Array.from({ length: 13 }, (_, i) => `  - id: m${i}\n    name: 成员${i}`).join('\n');
    expect(() => parseTeamTemplateYaml(
      MINIMAL.replace('  - id: a\n    name: 写手', members),
    )).toThrow(/at most 12/);
  });

  it('collects unknown icon/color as warnings instead of failing', () => {
    const { template, warnings } = parseTeamTemplateYaml(
      MINIMAL.replace('name: 写手', "name: 写手\n    icon: rocketship\n    color: neon"),
    );
    expect(template.members[0].icon).toBeUndefined();
    expect(warnings.some((w) => w.includes('icon'))).toBe(true);
    expect(warnings.some((w) => w.includes('color'))).toBe(true);
  });

  it('validates the model block (mutually exclusive keys, provider+model required)', () => {
    expect(() => parseTeamTemplateYaml(
      MINIMAL.replace('team:', 'model:\n  provider: zai\n  model: glm-5.3-flash\n  api_key: a\n  api_key_env: B\nteam:'),
    )).toThrow(/mutually exclusive/);
    expect(() => parseTeamTemplateYaml(
      MINIMAL.replace('team:', 'model:\n  provider: zai\nteam:'),
    )).toThrow(/provider and model/);
    const { template, warnings } = parseTeamTemplateYaml(
      MINIMAL.replace('team:', 'model:\n  provider: zai\n  model: glm-5.3-flash\nteam:'),
    );
    expect(template.model?.provider).toBe('zai');
    expect(warnings.some((w) => w.includes('no api_key'))).toBe(true);
  });
});

describe('team_templates.buildWelcomeText', () => {
  it('mentions every member and renders acceptance as a list', () => {
    const { template } = parseTeamTemplateYaml(MINIMAL + 'acceptance:\n  - 有来源\n  - 可发布\n');
    const text = buildWelcomeText(template);
    expect(text).toContain('@写手');
    expect(text).toContain('开始工作');
    expect(text).toContain('验收标准：');
    expect(text).toContain('- 有来源');
  });
});

describe('team_templates.roundtrip', () => {
  it('stringify → parse preserves the template shape', () => {
    const first = parseTeamTemplateYaml(MINIMAL).template;
    const second = parseTeamTemplateYaml(stringifyTeamTemplate(first)).template;
    expect(second.team.id).toBe(first.team.id);
    expect(second.team.name).toBe(first.team.name);
    expect(second.members[0].name).toBe(first.members[0].name);
    expect(second.welcome_task.text).toBe(first.welcome_task.text);
  });
});

describe('team_templates.plan_required', () => {
  it('parses plan_required and renders the plan-first contract', () => {
    const { template } = parseTeamTemplateYaml(
      MINIMAL.replace('welcome_task:', 'plan_required: true\nwelcome_task:'),
    );
    expect(template.plan_required).toBe(true);
    const text = buildWelcomeText(template);
    expect(text).toContain('先由指挥官汇总各成员意见，输出一份执行计划');
    expect(text).toContain('等我回复"确认"后再开工');
  });

  it('omits the plan-first contract when plan_required is absent', () => {
    const text = buildWelcomeText(parseTeamTemplateYaml(MINIMAL).template);
    expect(text).not.toContain('执行方式');
  });

  it('accepts false explicitly', () => {
    const { template } = parseTeamTemplateYaml(
      MINIMAL.replace('team:', 'plan_required: false\nteam:'),
    );
    expect(template.plan_required).toBeUndefined();
    expect(buildWelcomeText(template)).not.toContain('执行方式');
  });
});
