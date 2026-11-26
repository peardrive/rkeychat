/**
 * The viewer pages through everything a conversation carries, not only one message: this is the list, in the order
 * the messages are shown, and where a pressed attachment sits in it.
 */
import type { ChatAttachment, ChatMessage } from '../kit';

export function threadAttachments(messages: readonly ChatMessage[]): ChatAttachment[] {
  const out: ChatAttachment[] = [];
  for (const m of messages) for (const a of m.attachments ?? []) out.push(a);
  return out;
}

/** The index of `a` in `items`: by id when it has one, else the same name and url. */
export function attachmentIndex(items: readonly ChatAttachment[], a: ChatAttachment): number {
  const i = a.id ? items.findIndex((x) => x.id === a.id) : -1;
  return i >= 0 ? i : items.findIndex((x) => x.name === a.name && x.url === a.url);
}
