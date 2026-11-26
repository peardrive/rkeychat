import { describe, expect, it } from 'vitest';
import { attachmentIndex, threadAttachments } from './attachments';
import type { ChatMessage } from '../kit';

const m = (id: string, atts?: { id?: string; name: string; url?: string }[]): ChatMessage => ({ id, author: { id: 'a', name: 'a' }, ts: 1, text: '', attachments: atts });

describe('the viewer pages through a whole conversation', () => {
  it('lists every attachment in message order and finds a pressed one', () => {
    const items = threadAttachments([m('1', [{ id: 'x', name: 'a.png', url: '/a' }]), m('2'), m('3', [{ id: 'y', name: 'b.png', url: '/b' }, { name: 'c.pdf', url: '/c' }])]);
    expect(items.map((i) => i.name)).toEqual(['a.png', 'b.png', 'c.pdf']);
    expect(attachmentIndex(items, { id: 'y', name: 'b.png' })).toBe(1);
    expect(attachmentIndex(items, { name: 'c.pdf', url: '/c' })).toBe(2);
    expect(attachmentIndex(items, { name: 'nope' })).toBe(-1);
  });
});
