/**
 * The bot's settings as the profile shows them (2026-11-22, Guy's memo): the permission modes in a person's words,
 * the models offered as choices, and the providers as a segmented control (the login first). The daemon holds the
 * same lists in src/seat-settings.js; this is the shell's reading of them.
 */
import type { PermissionMode, Provider, Seat } from '../types';

export const PERMISSION_MODES: { value: PermissionMode; label: string; hint: string }[] = [
  { value: 'default', label: 'Ask', hint: 'Asks before every change. The tool list still answers what it covers.' },
  { value: 'acceptEdits', label: 'Edits', hint: 'Edits inside its folder without asking; everything else asks.' },
  { value: 'plan', label: 'Plan', hint: 'Reads and plans only; no change until the mode is switched.' },
  { value: 'auto', label: 'Auto', hint: 'Claude Code decides most permissions itself. The deny rules still win.' },
];

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
export function runLine(seat: Pick<Seat, 'permissionMode' | 'model' | 'provider'> | null | undefined): string {
  if (!seat) return '';
  const mode = PERMISSION_MODES.find((m) => m.value === (seat.permissionMode ?? 'acceptEdits'))?.label ?? seat.permissionMode;
  return `${mode} · ${modelName(seat.model)} · ${seat.provider ? `via ${seat.provider}` : 'Claude login'}`;
}
