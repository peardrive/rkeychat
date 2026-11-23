import { describe, expect, it } from 'vitest';
import { PERMISSION_MODES, autoLeft, autoWords, isCustomModel, modelName, permissionModeHint, providerOptions, runLine } from './seatSettings';

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

describe('Auto with a grant', () => {
  it('words for a grant or a cap, and the line under the name', () => {
    expect(autoWords({ minutes: 30, turns: 5 })).toBe('30 min, 5 turns');
    expect(autoWords({ minutes: null, turns: 1 })).toBe('1 turn');
    expect(autoWords(null)).toBe('');
    expect(runLine({ permissionMode: 'auto', auto: { minutes: null, turns: 5 }, model: null, provider: null })).toBe('Auto (5 turns) · Default · Claude login');
    expect(runLine({ permissionMode: 'auto', auto: null, model: null, provider: null })).toBe('Auto · Default · Claude login');
  });

  it('where the grant stands: the tighter of the seat\'s own limit and the room\'s cap', () => {
    const now = 10_000_000;
    const grant = { since: now - 10 * 60_000, minutes: 30, turns: 5, used: 2 };
    expect(autoLeft(grant, null, now)).toBe('20 min left · 3 turns left');
    expect(autoLeft(grant, { minutes: 15, turns: null }, now)).toBe('5 min left · 3 turns left');
    expect(autoLeft(grant, { minutes: null, turns: 2 }, now)).toBe('over');
    expect(autoLeft(grant, null, now + 25 * 60_000)).toBe('over');
    expect(autoLeft({ since: now, minutes: null, turns: null }, null, now)).toBe('no limit');
    expect(autoLeft(null, { minutes: 10, turns: null }, now)).toBe('10 min left');
  });
});
