/**
 * Daemon records → PearKit chat shapes.
 */
import type { AskAnswer, AskChoice, ChatMessage } from '../kit';
import { askFoldLine, askStatus, type FoldedAsk } from 'pearkit/asks';
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
  // the round budget (src/turns.js)
  const n = Number(rec.n) || 0;
  if (rec.action === 'rounds') return n ? `${rec.name} set ${n} ${n === 1 ? 'round' : 'rounds'} per message` : `${rec.name} put the default rounds back`;
  if (rec.action === 'extend') return `${rec.name} gave ${n || 1} more ${n === 1 ? 'round' : 'rounds'}`;
  if (rec.action === 'unlimited') return `${rec.name} lifted the round limit`;
  if (rec.action === 'until') return `${rec.name} opened the agents for a while`;
  if (rec.action === 'reset') return `${rec.name} reset the rounds`;
  if (rec.action === 'limit') return n ? `${rec.name} limited @${rec.agent} to ${n} ${n === 1 ? 'post' : 'posts'} per message` : `${rec.name} lifted @${rec.agent}'s post limit`;
  if (rec.action === 'pause') return `${rec.name} paused ${rec.agent ? `@${rec.agent}` : 'the agents'}`;
  if (rec.action === 'resume') return `${rec.name} resumed ${rec.agent ? `@${rec.agent}` : 'the agents'}`;
  return `${rec.name}: ${rec.action ?? 'control'}`;
}

/** A message, an activity record, an ask or a control as the chat list shows it. */
export function toChatMessage(rec: Rec, opts: { me?: string | null; reactions?: Reactions } = {}): ChatMessage {
  const system = rec.kind === 'activity' || rec.kind === 'control' || rec.kind === 'fold';
  const ask = rec.kind === 'ask';
  return {
    id: rec.id,
    author: { id: rec.name, name: rec.name, agent: !rec.human },
    ts: rec.ts,
    // A record may carry no text at all (an attachment-only message, an older redaction): Markdown needs a string.
    text: rec.kind === 'activity' ? `${rec.name}: ${rec.text ?? ''}` : rec.kind === 'fold' ? `${rec.name} ${rec.text ?? ''}` : rec.kind === 'control' ? controlLine(rec) : ask ? `asks for ${rec.tool ?? 'a tool'}: ${rec.what ?? ''}` : rec.text ?? '',
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
 * Collapse the quiet stretches of a thread. A run of consecutive steps (activity) and settled asks (answered, or
 * lapsed with nobody answering) between two messages becomes one line. With no asks in it: the last step's text,
 * with the rest counted ("+4 earlier steps"). With asks: ONE `fold` record, the block of permissions asked
 * ("asked for 3 permissions · 3 allowed · 8 steps"), which the UI opens to one line per ask (2026-11-23 memo:
 * "they only ever take up one block"). An open ask always stands as its card. At the end of the thread the block
 * comes first and the live step line under it, so what the bot is doing now stays in view. "All steps" in the UI
 * turns the folding off.
 */
export function collapseActivity(items: Rec[], asks: Map<string, PairedAsk> = new Map(), now = Date.now()): Rec[] {
  const status = (r: Rec) => askStatus({ expires: r.expires ?? 0 }, asks.get(r.id)?.answer ?? null, now);
  const settled = (r: Rec) => r.kind === 'ask' && status(r) !== 'open';
  const folded = (r: Rec): FoldedAsk => ({ id: r.id, tool: r.tool ?? 'a tool', what: r.what ?? '', status: status(r), by: asks.get(r.id)?.answer?.by ?? null });
  let lastMsg = -1;
  items.forEach((r, i) => { if (r.kind === 'msg') lastMsg = i; });
  const out: Rec[] = [];
  let run: Rec[] = [];
  let runStart = 0;
  const stepLine = (steps: Rec[]) => {
    if (!steps.length) return;
    const last = steps[steps.length - 1];
    out.push(steps.length > 1 ? { ...last, text: `${last.text}  (+${plural(steps.length - 1, 'earlier step')})` } : last);
  };
  const fold = (asked: Rec[], steps: number) => {
    const first = asked[0];
    const list = asked.map(folded);
    out.push({ ...first, kind: 'fold', id: `${first.id}~fold`, text: askFoldLine(list, steps), fold: { asks: list, steps } });
  };
  const flush = (tail: boolean) => {
    if (!run.length) return;
    const steps = run.filter((r) => r.kind === 'activity');
    const asked = run.filter((r) => r.kind === 'ask');
    if (!asked.length) stepLine(steps);
    else if (tail) {
      fold(asked, 0);
      stepLine(steps);
    } else fold(asked, steps.length);
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
