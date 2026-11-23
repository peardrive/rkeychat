/**
 * The bot's settings as the profile shows them (2026-11-22, Guy's memo): the permission modes in a person's words,
 * the models offered as choices, and the providers as a segmented control (the login first). The daemon holds the
 * same lists in src/seat-settings.js; this is the shell's reading of them.
 */
import type { AutoGrant, AutoLimit, PermissionMode, Provider, Seat } from '../types';

export const PERMISSION_MODES: { value: PermissionMode; label: string; hint: string }[] = [
  { value: 'default', label: 'Ask', hint: 'Asks before every change. The tool list still answers what it covers.' },
  { value: 'acceptEdits', label: 'Edits', hint: 'Edits inside its folder without asking; everything else asks.' },
  { value: 'plan', label: 'Plan', hint: 'Reads and plans only; no change until the mode is switched.' },
  { value: 'auto', label: 'Auto', hint: 'Runs without asking you: every call is allowed except what its deny rules refuse. Give it minutes or turns below, or let it run until you switch it back.' },
];

/** "30 min, 5 turns" from a grant or a cap; '' when neither is set. */
export function autoWords(limit: Pick<AutoLimit, 'minutes' | 'turns'> | null | undefined): string {
  if (!limit) return '';
  const parts: string[] = [];
  if (limit.minutes) parts.push(`${limit.minutes} min`);
  if (limit.turns) parts.push(`${limit.turns} turn${limit.turns === 1 ? '' : 's'}`);
  return parts.join(', ');
}

/**
 * Where an Auto grant stands now, the room's cap counted in (the tighter of the two): "23 min left · 3 turns left",
 * "no limit", or "over" once something ran out. The daemon does the same sum (src/seat-settings.js autoState).
 */
export function autoLeft(auto: AutoGrant | null | undefined, cap: AutoLimit | null | undefined, now = Date.now()): string {
  const tight = (k: 'minutes' | 'turns') => [auto?.[k], cap?.[k]].filter((v): v is number => v != null).reduce((a, b) => Math.min(a, b), Infinity);
  const minutes = tight('minutes');
  const turns = tight('turns');
  const parts: string[] = [];
  if (minutes !== Infinity) {
    const until = (auto?.since ?? now) + minutes * 60_000;
    if (now >= until) return 'over';
    parts.push(`${Math.ceil((until - now) / 60_000)} min left`);
  }
  if (turns !== Infinity) {
    const left = Math.max(0, turns - (auto?.used ?? 0));
    if (left === 0) return 'over';
    parts.push(`${left} turn${left === 1 ? '' : 's'} left`);
  }
  return parts.join(' · ') || 'no limit';
}

export const permissionModeHint = (mode: PermissionMode | undefined) => PERMISSION_MODES.find((m) => m.value === (mode ?? 'acceptEdits'))?.hint ?? '';

/** The models offered as chips; `null` is the login's own default. Any other id is typed in. */
export const MODELS: { id: string; name: string }[] = [
  { id: 'claude-fable-5-1', name: 'Fable 5.1' },
  { id: 'claude-opus-5-5', name: 'Opus 5.5' },
  { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5' },
  { id: 'claude-haiku-5-5', name: 'Haiku 5.5' },
];

export const modelName = (id: string | null | undefined) => (id ? MODELS.find((m) => m.id === id)?.name ?? id : 'Default');

/** True when the seat's model is one a person typed, not one of the chips. */
export const isCustomModel = (id: string | null | undefined) => !!id && !MODELS.some((m) => m.id === id);

/** The provider control: the login first, then every provider on the device; a provider without a token is marked. */
export function providerOptions(providers: Pick<Provider, 'name' | 'hasToken'>[]): { value: string; label: string }[] {
  return [{ value: 'claude', label: 'Claude login' }, ...providers.map((p) => ({ value: p.name, label: p.hasToken ? p.name : `${p.name} (no key)` }))];
}

/** One line under the bot's name: how it runs. */
export function runLine(seat: Pick<Seat, 'permissionMode' | 'model' | 'provider' | 'auto'> | null | undefined): string {
  if (!seat) return '';
  const mode = PERMISSION_MODES.find((m) => m.value === (seat.permissionMode ?? 'acceptEdits'))?.label ?? seat.permissionMode;
  const grant = seat.permissionMode === 'auto' ? autoWords(seat.auto) : '';
  return `${mode}${grant ? ` (${grant})` : ''} · ${modelName(seat.model)} · ${seat.provider ? `via ${seat.provider}` : 'Claude login'}`;
}
