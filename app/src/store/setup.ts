/**
 * First-run setup, the pure part: which steps apply on this device, which ways of connecting an AI are offered,
 * where each stands, and the summary the last step shows. The components read these; the tests pin them.
 */
import type { IconName } from '../kit';
import type { SetupInfo } from '../types';

export type SetupStepKey = 'agent' | 'folder' | 'done';

export const SETUP_STEPS: { key: SetupStepKey; title: string }[] = [
  { key: 'agent', title: 'Connect your AI' },
  { key: 'folder', title: 'Where projects live' },
  { key: 'done', title: 'Ready' },
];

/** The steps that apply here: a phone holds no folders, so it has no folder step. */
export function setupSteps(info: Pick<SetupInfo, 'canHost'>): { key: SetupStepKey; title: string }[] {
  return SETUP_STEPS.filter((s) => s.key !== 'folder' || info.canHost);
}

/** The flow is wanted on screen: the device is set up enough to know, and the person has not finished or skipped it. */
export function needsSetup(info: SetupInfo | null): boolean {
  return !!info && !info.done;
}

/** A standing notice is wanted: no agent can run yet (on a computer). On a phone agents run elsewhere, so none. */
export function needsAgent(info: SetupInfo | null): boolean {
  return !!info && info.canHost && !info.connected;
}

export type AgentChoice = {
  key: string; // 'claude' or a preset name
  title: string;
  description: string;
  icon: IconName;
  tag?: string;
  /** Where it stands on this device. */
  state: 'ready' | 'needs-key' | 'needs-login' | 'none';
  /** The one new seats run on. */
  chosen: boolean;
};

const ICONS: Record<string, IconName> = { claude: 'robot', ppq: 'bolt', openrouter: 'globe', llamacpp: 'home' };

/** The ways offered: the Claude login first, then each preset, with where each stands. */
export function agentChoices(info: SetupInfo): AgentChoice[] {
  const chosen = info.agent ?? (info.claude.loggedIn ? 'claude' : null);
  const out: AgentChoice[] = [
    {
      key: 'claude',
      title: 'Claude subscription',
      description: info.claude.loggedIn ? `Logged in${info.claude.email ? ` as ${info.claude.email}` : ''}${info.claude.plan ? ` · ${info.claude.plan}` : ''}` : 'Log in with your Claude account. Uses the plan you already pay for.',
      icon: ICONS.claude,
      tag: 'recommended',
      state: info.claude.loggedIn ? 'ready' : 'needs-login',
      chosen: chosen === 'claude',
    },
  ];
  for (const [key, p] of Object.entries(info.presets ?? {})) {
    const held = info.providers.find((x) => x.name === key || x.preset === key);
    out.push({
      key,
      title: p.label,
      description: p.blurb ?? p.baseUrl,
      icon: ICONS[key] ?? 'globe',
      tag: p.key === 'none' ? 'no key' : undefined,
      state: held?.ready ? 'ready' : p.key === 'required' ? 'needs-key' : 'none',
      chosen: chosen === key,
    });
  }
  return out;
}

/** What the last step shows, one line each. */
export function setupSummary(info: SetupInfo): string[] {
  const lines: string[] = [];
  lines.push(info.name ? `@${info.name} on ${info.device}` : info.device);
  if (!info.canHost) lines.push('Agents run on your computer; this phone talks to them.');
  else if (!info.connected) lines.push('AI: not connected yet (Home will remind you)');
  else if (!info.agent || info.agent === 'claude') lines.push(`AI: Claude subscription${info.claude.email ? `, ${info.claude.email}` : ''}`);
  else lines.push(`AI: ${info.presets?.[info.agent]?.label ?? info.agent}`);
  if (info.canHost) lines.push(`Projects: ${info.workspace}`);
  return lines;
}
