/**
 * The room's round budget as the daemon reports it (src/turns.js, serialized by the server), and the one line
 * the project pane says about it.
 */
import type { Budget } from '../types';
import { shortTime } from '../time';

/** "paused", "no round limit", "open until 4:00 PM", "2 of 5 rounds left per message", "5 rounds per message". */
export function roundsLine(b: Budget | null | undefined, now = Date.now()): string {
  if (!b) return '';
  if (b.paused) return 'paused';
  if (b.unlimited) return 'no round limit';
  if (b.until && b.until > now) return `open until ${shortTime(b.until, now)}`;
  const rounds = b.rounds ?? b.limit;
  const left = b.remaining;
  if (left != null && left < b.limit) return `${left} of ${b.limit} ${b.limit === 1 ? 'round' : 'rounds'} left, then ${rounds} per message`;
  return `${rounds} ${rounds === 1 ? 'round' : 'rounds'} per message`;
}

/** The posts an agent may make between two human messages, as set by 'limit' (0 = no limit). */
export function agentPostLimit(b: Budget | null | undefined, name: string): number {
  return b?.agents?.limits?.[name] ?? 0;
}
