/**
 * The home feed: what needs you and what happened, built client-side from the daemon's pushes.
 */
import type { LoginAsk } from '../types';

export type FeedKind = 'approval' | 'mention' | 'done' | 'error' | 'conversation' | 'project' | 'file' | 'publish';

export type FeedItem = {
  id: string;
  kind: FeedKind;
  ts: number;
  title: string;
  text?: string;
  /** Who did it (a seat, a person, a device). */
  who?: string;
  whoAgent?: boolean;
  /** The breadcrumb: organization › project › conversation. */
  where?: { org?: string; project: string; conversation?: string };
  topic?: string;
  conv?: string;
  unread: boolean;
  ask?: LoginAsk;
};

export const FEED_MAX = 200;

/** Newest first, at most FEED_MAX, one item per id (a repeat replaces the old one in place of the newest). */
export function pushFeed(feed: FeedItem[], item: FeedItem): FeedItem[] {
  const rest = feed.filter((x) => x.id !== item.id);
  return [item, ...rest].slice(0, FEED_MAX);
}

export const feedUnread = (feed: FeedItem[]) => feed.filter((x) => x.unread).length;

/** `@name` anywhere in the text, as a word. */
export function mentions(text: string, name: string | null | undefined): boolean {
  if (!name) return false;
  const re = new RegExp(`(^|[^\\w])@${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'i');
  return re.test(text ?? '');
}
