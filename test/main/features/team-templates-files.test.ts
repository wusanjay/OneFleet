import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { parseTeamTemplateYaml, buildWelcomeText } from '../../../src/main/features/team_templates';

const TEMPLATE_DIR = process.env.ONEFLEET_TEMPLATE_DIR ?? '../../templates';

describe('shipped fleet templates', () => {
  for (const f of ['solo-growth', 'indie-sales', 'competitor-radar']) {
    it(`${f}.yaml parses and its welcome task mentions every member`, () => {
      const p = `${TEMPLATE_DIR}/${f}.yaml`;
      if (!existsSync(p)) return; // templates dir is external to the app repo
      const { template, warnings } = parseTeamTemplateYaml(readFileSync(p, 'utf8'));
      expect(warnings).toEqual([]);
      expect(template.members.length).toBeGreaterThanOrEqual(3);
      const text = buildWelcomeText(template);
      for (const m of template.members) expect(text).toContain(`@${m.name}`);
      if (template.acceptance?.length) expect(text).toContain('验收标准：');
    });
  }
});
