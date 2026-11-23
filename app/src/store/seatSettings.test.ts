import { describe, expect, it } from 'vitest';
import { PERMISSION_MODES, isCustomModel, modelName, permissionModeHint, providerOptions, runLine } from './seatSettings';

describe('the bot\'s settings as the profile reads them', () => {
  it('offers the four modes and never bypass; the default mode is Edits', () => {
    expect(PERMISSION_MODES.map((m) => m.value)).toEqual(['default', 'acceptEdits', 'plan', 'auto']);
    expect(PERMISSION_MODES.some((m) => /bypass/i.test(m.value) || /bypass/i.test(m.label))).toBe(false);
    expect(permissionModeHint(undefined)).toMatch(/inside its folder/);
    expect(permissionModeHint('default')).toMatch(/before every change/);
  });

  it('names the model: a chip by its name, a typed id as itself, none as Default', () => {
    expect(modelName('claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelName('claude-fable-5-1')).toBe('Fable 5.1');
    expect(modelName('qwen-3-coder')).toBe('qwen-3-coder');
    expect(modelName(null)).toBe('Default');
    expect(isCustomModel('qwen-3-coder')).toBe(true);
    expect(isCustomModel('claude-opus-5-5')).toBe(false);
    expect(isCustomModel(null)).toBe(false);
  });

  it('the provider control starts with the login and marks a provider that has no key yet', () => {
    expect(providerOptions([])).toEqual([{ value: 'claude', label: 'Claude login' }]);
    expect(providerOptions([{ name: 'ppq', hasToken: true }, { name: 'router', hasToken: false }])).toEqual([
      { value: 'claude', label: 'Claude login' },
      { value: 'ppq', label: 'ppq' },
      { value: 'router', label: 'router (no key)' },
    ]);
  });

  it('the one-line summary under the bot\'s name', () => {
    expect(runLine({ permissionMode: 'acceptEdits', model: null, provider: null })).toBe('Edits · Default · Claude login');
    expect(runLine({ permissionMode: 'default', model: 'claude-opus-5-5', provider: 'ppq' })).toBe('Ask · Opus 5.5 · via ppq');
    expect(runLine({})).toBe('Edits · Default · Claude login');
    expect(runLine(null)).toBe('');
  });
});
