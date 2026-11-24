import { describe, expect, it } from 'vitest';
import { agentChoices, needsAgent, needsSetup, setupSteps, setupSummary } from './setup';
import type { SetupInfo } from '../types';

const PRESETS = {
  ppq: { label: 'PPQ', baseUrl: 'https://api.ppq.ai', key: 'required' as const },
  openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api', key: 'required' as const },
  llamacpp: { label: 'llama.cpp', baseUrl: 'http://127.0.0.1:8080', key: 'none' as const },
};
const fresh: SetupInfo = { name: 'ben', device: 'ben-macbook', canHost: true, claude: { loggedIn: false }, providers: [], presets: PRESETS, agent: null, connected: false, workspace: '/Users/ben/rKeyChat', workspaceSet: false, done: false };

describe('first-run setup', () => {
  it('has three steps on a computer and two on a phone (no folders there)', () => {
    expect(setupSteps({ canHost: true }).map((s) => s.key)).toEqual(['agent', 'folder', 'done']);
    expect(setupSteps({ canHost: false }).map((s) => s.key)).toEqual(['agent', 'done']);
  });

  it('is shown until finished or skipped; the agent notice stays while nothing can run, on a computer only', () => {
    expect(needsSetup(null)).toBe(false);
    expect(needsSetup(fresh)).toBe(true);
    expect(needsSetup({ ...fresh, done: true })).toBe(false);
    expect(needsAgent({ ...fresh, done: true })).toBe(true);
    expect(needsAgent({ ...fresh, done: true, connected: true })).toBe(false);
    expect(needsAgent({ ...fresh, done: true, canHost: false })).toBe(false);
  });

  it('offers the Claude login first, then PPQ, OpenRouter and llama.cpp, each with where it stands', () => {
    const c = agentChoices(fresh);
    expect(c.map((x) => [x.key, x.state])).toEqual([
      ['claude', 'needs-login'],
      ['ppq', 'needs-key'],
      ['openrouter', 'needs-key'],
      ['llamacpp', 'none'],
    ]);
    expect(c.find((x) => x.key === 'llamacpp')?.tag).toBe('no key');
    expect(c.every((x) => !x.chosen)).toBe(true);
  });

  it('a held key makes a preset ready; the login held and nothing chosen means the login is the one in use', () => {
    const withKey = { ...fresh, providers: [{ name: 'ppq', baseUrl: 'https://api.ppq.ai', hasToken: true, preset: 'ppq', label: 'PPQ', ready: true }], agent: 'ppq', connected: true };
    const c = agentChoices(withKey);
    expect(c.find((x) => x.key === 'ppq')).toMatchObject({ state: 'ready', chosen: true });
    const loggedIn = { ...fresh, claude: { loggedIn: true, email: 'ben@example.com', plan: 'pro' }, connected: true };
    const cl = agentChoices(loggedIn)[0];
    expect(cl).toMatchObject({ state: 'ready', chosen: true });
    expect(cl.description).toBe('Logged in as ben@example.com · pro');
  });

  it('the summary says who, which AI and where projects go', () => {
    expect(setupSummary({ ...fresh, claude: { loggedIn: true, email: 'ben@example.com' }, connected: true })).toEqual(['@ben on ben-macbook', 'AI: Claude subscription, ben@example.com', 'Projects: /Users/ben/rKeyChat']);
    expect(setupSummary({ ...fresh, agent: 'llamacpp', connected: true })[1]).toBe('AI: llama.cpp');
    expect(setupSummary(fresh)[1]).toBe('AI: not connected yet (Home will remind you)');
    expect(setupSummary({ ...fresh, canHost: false })).toEqual(['@ben on ben-macbook', 'Agents run on your computer; this phone talks to them.']);
  });
});
