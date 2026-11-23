/**
 * Daemon records → PearKit chat shapes.
 */
import type { AskAnswer, AskChoice, ChatMessage } from '../kit';
import { askStatus } from 'pearkit/asks';
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
 * What the conversation does not show as a line of its own: a seat's settings (the request and the host's echo
 * live on the bot's profile, and a host echoes them into every room its seats sit in), and the answer to an ask
 * (the ask's card says who answered and how). Both still arrive and are kept; `pairAsks` reads the answers.
 */
export function inThread(rec: Rec): boolean {
  return rec.kind !== 'control' || (rec.action !== 'seat' && rec.action !== 'answer');
}

export type PairedAsk = { rec: Rec; answer: AskAnswer | null };

/** The asks of a thread, each with its answer when one came (the first admitted 'answer' control wins). */
export function pairAsks(items: Rec[]): Map<string, PairedAsk> {
  const out = new Map<string, PairedAsk>();
  for (const r of items) if (r.kind === 'ask') out.set(r.id, { rec: r, answer: null });
  for (const r of items) {
    if (r.kind !== 'control' || r.action !== 'answer' || !r.ask) continue;
    const a = out.get(r.ask);
    if (a && !a.answer) a.answer = { choice: r.choice as AskChoice, by: r.name, device: r.device || undefined, ts: r.ts };
  }
  return out;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Collapse the quiet stretches of a thread. A run of consecutive steps (activity) and settled asks (allowed, or
 * lapsed with nobody answering) folds into one line: the last step's text, or the last ask as "asked for Bash:
 * …", with what is folded in brackets ("+4 earlier steps · 3 asks allowed"). An open ask always stands as its
 * card, so does a refused one, and after the last message of the thread every ask does: the card the person
 * just answered stays until the bot has spoken again. "All steps" in the UI turns the folding off.
 */
export function collapseActivity(items: Rec[], asks: Map<string, PairedAsk> = new Map(), now = Date.now()): Rec[] {
  const settled = (r: Rec) => {
    if (r.kind !== 'ask') return false;
    const s = askStatus({ expires: r.expires ?? 0 }, asks.get(r.id)?.answer ?? null, now);
    return s === 'allowed' || s === 'lapsed';
  };
  let lastMsg = -1;
  items.forEach((r, i) => { if (r.kind === 'msg') lastMsg = i; });
  const out: Rec[] = [];
  let run: Rec[] = [];
  let runStart = 0;
  const flush = (tail: boolean) => {
    if (!run.length) return;
    if (tail) {
      // the end of the thread: the asks stand, the steps between them collapse as ever
      let steps: Rec[] = [];
      const step = () => {
        if (!steps.length) return;
        const last = steps[steps.length - 1];
        out.push(steps.length > 1 ? { ...last, text: `${last.text}  (+${plural(steps.length - 1, 'earlier step')})` } : last);
        steps = [];
      };
      for (const r of run) {
        if (r.kind === 'activity') steps.push(r);
        else {
          step();
          out.push(r);
        }
      }
      step();
    } else {
      const last = run[run.length - 1];
      const hidden = run.slice(0, -1);
      const stepsHidden = hidden.filter((r) => r.kind === 'activity').length;
      const asked = run.filter((r) => r.kind === 'ask');
      const allowed = asked.filter((r) => asks.get(r.id)?.answer).length;
      const lapsed = asked.length - allowed;
      const parts: string[] = [];
      if (stepsHidden) parts.push(`+${plural(stepsHidden, 'earlier step')}`);
      if (asked.length === 1 && run.length === 1) parts.push(allowed ? 'allowed' : 'lapsed');
      else {
        if (allowed) parts.push(`${plural(allowed, 'ask')} allowed`);
        if (lapsed) parts.push(`${plural(lapsed, 'ask')} lapsed`);
      }
      const suffix = parts.length ? `  (${parts.join(' · ')})` : '';
      if (last.kind === 'activity') out.push(suffix ? { ...last, text: `${last.text}${suffix}` } : last);
      else out.push({ ...last, kind: 'activity', id: `${last.id}~folded`, text: `asked for ${last.tool ?? 'a tool'}: ${last.what ?? ''}${suffix}` });
    }
    run = [];
  };
  items.forEach((r, i) => {
    if (r.kind === 'activity' || settled(r)) {
      if (!run.length) runStart = i;
      run.push(r);
    } else {
      flush(runStart > lastMsg);
      out.push(r);
    }
  });
  flush(runStart > lastMsg);
  return out;
}
