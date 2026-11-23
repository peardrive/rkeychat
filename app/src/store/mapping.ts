/**
 * Daemon records → PearKit chat shapes.
 */
import type { ChatMessage } from '../kit';
import type { Attachment, Reactions, Rec } from '../types';
import { autoWords, runLine } from './seatSettings';

export function attachmentOf(a: Attachment): NonNullable<ChatMessage['attachments']>[number] {
  const audio = a.kind !== 'file';
  return {
    name: a.name ?? (audio ? 'Voice memo' : 'File'),
    size: a.size,
    kind: audio ? 'audio' : a.mime?.startsWith('image/') ? 'image' : 'file',
    url: `/api/blob/${a.hash}`,
  };
}

export function reactionsOf(reactions: Reactions | undefined, id: string, me: string | null): ChatMessage['reactions'] {
  const r = reactions?.[id];
  if (!r) return undefined;
  const out = Object.entries(r)
    .filter(([, names]) => names.length)
    .map(([emoji, names]) => ({ emoji, count: names.length, mine: !!me && names.includes(me) }));
  return out.length ? out : undefined;
}

const CHOICE_WORDS: Record<string, string> = { allow_once: 'allowed once', allow_always: 'allowed always', reject_once: 'refused', reject_always: 'refused always' };

/** A control as one muted line: an answer to an ask, a rename, a budget change. */
export function controlLine(rec: Rec): string {
  if (rec.action === 'answer') return `${rec.name}: ${CHOICE_WORDS[rec.choice ?? ''] ?? rec.choice ?? 'answered'}`;
  if (rec.action === 'rename') return `${rec.name} renamed the project`;
  if (rec.action === 'charter') return `${rec.name} changed the charter`;
  // a seat's settings: the request from one of the owner's devices, then the host's word on how the bot now runs
  if (rec.action === 'seat') return rec.seat?.applied ? `@${rec.agent} now runs: ${runLine(rec.seat)}` : `${rec.name} changed @${rec.agent}'s settings`;
  // the room's cap on Auto
  if (rec.action === 'auto') { const w = autoWords(rec.auto); return w ? `${rec.name} capped Auto in this project at ${w}` : `${rec.name} lifted the Auto cap`; }
  return `${rec.name}: ${rec.action ?? 'control'}`;
}

/** A message, an activity record, an ask or a control as the chat list shows it. */
export function toChatMessage(rec: Rec, opts: { me?: string | null; reactions?: Reactions } = {}): ChatMessage {
  const system = rec.kind === 'activity' || rec.kind === 'control';
  const ask = rec.kind === 'ask';
  return {
    id: rec.id,
    author: { id: rec.name, name: rec.name, agent: !rec.human },
    ts: rec.ts,
    // A record may carry no text at all (an attachment-only message, an older redaction): Markdown needs a string.
    text: rec.kind === 'activity' ? `${rec.name}: ${rec.text ?? ''}` : rec.kind === 'control' ? controlLine(rec) : ask ? `asks for ${rec.tool ?? 'a tool'}: ${rec.what ?? ''}` : rec.text ?? '',
    re: rec.re?.length ? rec.re : undefined,
    reactions: system ? undefined : reactionsOf(opts.reactions, rec.id, opts.me ?? null),
    attachments: rec.att?.length ? rec.att.map(attachmentOf) : undefined,
    pending: rec.pending || undefined,
    redacted: rec.redacted ? true : undefined,
    system: system || undefined,
  };
}

/** Messages and this conversation's activity, merged in time order. */
export function mergeThread(messages: Rec[], activity: Rec[]): Rec[] {
  if (!activity.length) return messages;
  const seen = new Set(messages.map((m) => m.id));
  const extra = activity.filter((a) => !seen.has(a.id));
  const all = [...messages, ...extra];
  // Pending sends stay at the tail; everything else by time.
  return all.sort((a, b) => Number(!!a.pending) - Number(!!b.pending) || a.ts - b.ts);
}

/**
 * Collapse runs of activity: of each run of consecutive activity records only the last one stays, with the
 * count of the hidden steps folded into its text. "All steps" in the UI turns this off.
 */
export function collapseActivity(items: Rec[]): Rec[] {
  const out: Rec[] = [];
  let run: Rec[] = [];
  const flush = () => {
    if (!run.length) return;
    const last = run[run.length - 1];
    out.push(run.length > 1 ? { ...last, text: `${last.text}  (+${run.length - 1} earlier ${run.length - 1 === 1 ? 'step' : 'steps'})` } : last);
    run = [];
  };
  for (const r of items) {
    if (r.kind === 'activity') run.push(r);
    else {
      flush();
      out.push(r);
    }
  }
  flush();
  return out;
}
