import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  profiles: [] as Array<{
    id: string;
    provider: string;
    model: string;
    apiKey: string;
    label: string;
    createdAt: number;
  }>,
}));

vi.mock('../../../src/main/features/auth', () => ({
  loadVideoProfiles: () => mocks.profiles.map((profile) => ({ ...profile })),
  saveVideoProfiles: (profiles: typeof mocks.profiles) => {
    mocks.profiles = profiles.map((profile) => ({ ...profile }));
  },
}));

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  addVideoProfile,
  flattenVideoProviderOptions,
  listVideoProfiles,
  removeVideoProfile,
  reorderVideoProfiles,
  listVideoProviderOptions,
} from '../../../src/main/features/video_auth';

beforeEach(() => {
  mocks.profiles = [];
});

describe('video auth profiles', () => {
  it('rejects unsupported or incomplete BYO profiles without persisting credentials', () => {
    expect(addVideoProfile({
      provider: 'doubao',
      model: 'retired-model',
      apiKey: 'must-not-be-stored',
    })).toEqual({
      ok: false,
      error: 'unsupported video model "doubao/retired-model"',
    });
    expect(addVideoProfile({
      provider: 'orkas-api',
      model: 'orkas-video',
      apiKey: '',
    })).toEqual({ ok: false, error: 'apiKey required' });
    expect(mocks.profiles).toEqual([]);
  });

  it('keeps explicit ordering and bounded labels deterministic', () => {
    const first = addVideoProfile({
      provider: 'orkas-api',
      model: 'orkas-video',
      apiKey: 'first',
      label: `  ${'x'.repeat(60)}  `,
    });
    const second = addVideoProfile({
      provider: 'orkas-api',
      model: 'orkas-video',
      apiKey: 'second',
      label: 'second',
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    reorderVideoProfiles([first.id, second.id]);
    expect(listVideoProfiles().map((profile) => profile.id)).toEqual([
      first.id,
      second.id,
    ]);
    expect(listVideoProfiles()[0]?.label).toHaveLength(40);

    expect(removeVideoProfile(second.id)).toEqual({ ok: true });
    expect(listVideoProfiles().map((profile) => profile.id)).toEqual([first.id]);
  });

  it('keeps the orkas-api provider out of the runtime picker (OneFleet fork gate)', () => {
    // flatten 本身是通用纯函数（对历史 profile 的回显仍有效），
    // 但用户可选列表必须为空——上游唯一的视频 provider 是托管 orkas 服务。
    const options = flattenVideoProviderOptions([
      { id: 'orkas-api', label: 'Orkas' },
      { id: 'doubao', label: 'DouBao' },
    ]);

    expect(options[0]).toMatchObject({
      id: 'orkas-api',
      provider: 'orkas-api',
      model: 'orkas-video',
      label: 'Orkas · Video',
    });
    expect(options).toHaveLength(1);
    expect(listVideoProviderOptions()).toEqual([]);
  });
});

 it('retains legacy credentials for removal but refuses new unsupported video profiles', () => {
    mocks.profiles = [{ id: 'legacy', provider: 'doubao', model: 'doubao-seedance-2-0-260128', apiKey: 'legacy-key', label: 'Legacy', createdAt: 1 }];
    expect(addVideoProfile({ provider: 'doubao', model: 'doubao-seedance-2-0-260128', apiKey: 'new-key' })).toMatchObject({ ok: false });
    expect(listVideoProfiles()).toEqual(mocks.profiles);
    expect(listVideoProfiles()).toHaveLength(1);
    expect(removeVideoProfile('legacy')).toEqual({ ok: true });
    expect(listVideoProfiles()).toEqual([]);
 });
