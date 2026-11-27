import { describe, expect, it } from 'vitest';
import { connectEvents } from './events';

// EventSource reopens by itself after a drop (iOS restarted the phone's backend). That second open is a reconnect:
// pushes were lost meanwhile and the page has to load state again (Guy, 2026-11-27).
class FakeES {
  static last: FakeES;
  static CLOSED = 2;
  readyState = 1;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FakeES.last = this;
  }
  addEventListener() {}
  close() {}
}

describe('event stream', () => {
  it('calls an open after a drop that EventSource retried itself a reconnect', () => {
    (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES;
    const opens: boolean[] = [];
    const sink = connectEvents({ onOpen: (r) => opens.push(r), onDrop: () => opens.push(false as never) });
    const es = FakeES.last;
    es.onopen!();
    es.readyState = 0; // CONNECTING: the browser retries on its own
    es.onerror!();
    es.onopen!();
    expect(opens).toEqual([false, false, true]);
    sink.close();
  });
});
