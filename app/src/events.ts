/**
 * The daemon's push channel: `GET /api/events` (SSE). Dispatches each named event to the handlers given,
 * reconnects with backoff when the stream drops and tells the caller so it can re-fetch state.
 */
import type { EventName, Events } from './types';

export type EventHandlers = { [K in EventName]?: (data: Events[K]) => void } & {
  /** The stream (re)opened. After a drop, re-fetch state: pushes may have been missed. */
  onOpen?: (reconnect: boolean) => void;
  onDrop?: () => void;
};

export interface EventSink {
  close(): void;
  readonly connected: boolean;
}

export const EVENT_NAMES: EventName[] = ['record', 'convs', 'room', 'rooms', 'participants', 'activity', 'agent-state', 'agent-error'];

/** Pluggable source: the real EventSource, or the mock bus. */
export type EventSourceFactory = (handlers: EventHandlers) => EventSink;

let factory: EventSourceFactory = sseFactory;
export function setEventSourceFactory(f: EventSourceFactory) {
  factory = f;
}

export function connectEvents(handlers: EventHandlers): EventSink {
  return factory(handlers);
}

function sseFactory(handlers: EventHandlers): EventSink {
  let es: EventSource | null = null;
  let closed = false;
  let connected = false;
  let attempts = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const open = () => {
    if (closed) return;
    es = new EventSource('/api/events');
    es.onopen = () => {
      connected = true;
      const reconnect = attempts > 0;
      attempts = 0;
      handlers.onOpen?.(reconnect);
    };
    es.onerror = () => {
      // EventSource retries by itself while CONNECTING; once CLOSED we take over with backoff.
      if (connected) {
        connected = false;
        handlers.onDrop?.();
      }
      if (es?.readyState === EventSource.CLOSED) {
        es.close();
        es = null;
        attempts += 1;
        const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempts, 5));
        timer = setTimeout(open, delay);
      }
    };
    for (const name of EVENT_NAMES) {
      es.addEventListener(name, (ev) => {
        const h = handlers[name] as ((d: unknown) => void) | undefined;
        if (!h) return;
        try {
          h(JSON.parse((ev as MessageEvent).data));
        } catch (e) {
          console.warn('[events] bad frame', name, e);
        }
      });
    }
  };

  open();

  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      es?.close();
      es = null;
    },
    get connected() {
      return connected;
    },
  };
}
