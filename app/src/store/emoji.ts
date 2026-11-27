/**
 * The person's most-used emoji, counted on every reaction they send and kept in localStorage.
 */
export const DEFAULT_EMOJI = ['👍', '❤️', '😂', '🎉', '🤔', '👀']; // emoji-ok: reactions a person sends
const KEY = 'rkc.app.emoji-use';

export type EmojiCounts = Record<string, number>;

export function readEmojiCounts(): EmojiCounts {
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? JSON.parse(raw) : {};
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

export function bumpEmoji(counts: EmojiCounts, emoji: string): EmojiCounts {
  return { ...counts, [emoji]: (counts[emoji] ?? 0) + 1 };
}

export function saveEmojiCounts(counts: EmojiCounts) {
  try {
    localStorage.setItem(KEY, JSON.stringify(counts));
  } catch {}
}

/** The `n` most used, then the defaults in order, without repeats. */
export function topEmoji(counts: EmojiCounts, n = 6, defaults = DEFAULT_EMOJI): string[] {
  const used = Object.entries(counts)
    .filter(([, c]) => c > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([e]) => e);
  const out: string[] = [];
  for (const e of [...used, ...defaults]) {
    if (!out.includes(e)) out.push(e);
    if (out.length === n) break;
  }
  return out;
}
