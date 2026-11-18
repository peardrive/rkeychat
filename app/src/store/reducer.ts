/**
 * Pure app state. Everything the shell shows derives from here; pushes and API results arrive as actions.
 */
import type { AgentState, Conversation, Rec, RoomSnapshot, RoomSummary, Participant } from '../types';

export const convKey = (topic: string, conv: string) => `${topic}/${conv}`;

export type Thread = { items: Rec[]; hasOlder: boolean; loaded: boolean; loadingOlder?: boolean };

export type RoomDetail = Pick<RoomSnapshot, 'charter' | 'seats' | 'folder' | 'app' | 'participants' | 'members' | 'reactions' | 'owner' | 'admitted'>;

export type State = {
  ready: boolean;
  connected: boolean;
  error: string | null;
  me: { device: string; human: string | null } | null;
  roomOrder: string[];
  rooms: Record<string, RoomSummary>;
  details: Record<string, RoomDetail>;
  convs: Record<string, Conversation[]>;
  threads: Record<string, Thread>;
  activity: Record<string, Rec[]>;
  /** `${topic}/${conv}` → seat name → state */
  agents: Record<string, Record<string, AgentState>>;
  unread: Record<string, number>;
  selected: { topic: string | null; conv: string | null };
};

export const initialState: State = {
  ready: false,
  connected: false,
  error: null,
  me: null,
  roomOrder: [],
  rooms: {},
  details: {},
  convs: {},
  threads: {},
  activity: {},
  agents: {},
  unread: {},
  selected: { topic: null, conv: null },
};

export type Action =
  | { type: 'init'; device: { name: string; human: string | null }; rooms: RoomSummary[]; current?: RoomSnapshot | null }
  | { type: 'rooms'; rooms: RoomSummary[] }
  | { type: 'room'; snapshot: RoomSnapshot; conv?: string }
  | { type: 'convs'; topic: string; convs: Conversation[] }
  | { type: 'conv'; topic: string; conv: Conversation }
  | { type: 'select'; topic: string | null; conv: string | null }
  | { type: 'record'; topic: string; rec: Rec }
  | { type: 'log'; topic: string; conv: string; log: Rec[]; hasOlder: boolean; mode: 'replace' | 'older' }
  | { type: 'loadingOlder'; topic: string; conv: string; value: boolean }
  | { type: 'activity'; topic: string; rec: Rec }
  | { type: 'agentState'; topic: string; name: string; conv: string; state: AgentState }
  | { type: 'participants'; topic: string; participants: Participant[] }
  | { type: 'sendPending'; topic: string; conv: string; rec: Rec }
  | { type: 'sendDone'; topic: string; conv: string; localId: string; rec: Rec }
  | { type: 'sendFailed'; topic: string; conv: string; localId: string }
  | { type: 'connected'; value: boolean }
  | { type: 'error'; error: string | null };

const MAX_ACTIVITY = 200;

function detailOf(s: RoomSnapshot): RoomDetail {
  return {
    charter: s.charter ?? { text: '', order: [], agents: {} },
    seats: s.seats ?? [],
    folder: s.folder ?? null,
    app: s.app ?? null,
    participants: s.participants ?? [],
    members: s.members ?? [],
    reactions: s.reactions ?? {},
    owner: s.owner,
    admitted: s.admitted,
  };
}

/** Insert or replace a record by id, keeping the list sorted by ts (pending ones stay last). */
function upsert(items: Rec[], rec: Rec): Rec[] {
  const i = items.findIndex((x) => x.id === rec.id);
  if (i >= 0) {
    const next = items.slice();
    next[i] = { ...items[i], ...rec, pending: rec.pending };
    return next;
  }
  const next = items.slice();
  // Keep chronological order without disturbing optimistic sends at the tail.
  let at = next.length;
  while (at > 0 && !next[at - 1].pending && next[at - 1].ts > rec.ts) at -= 1;
  next.splice(at, 0, rec);
  return next;
}

function applyRooms(state: State, rooms: RoomSummary[]): State {
  const next: Record<string, RoomSummary> = {};
  for (const r of rooms) next[r.topic] = r;
  const convs = { ...state.convs };
  // A summary carries the conversation list too; use it where we have no full list yet.
  for (const r of rooms) {
    if (!convs[r.topic] && r.convs) {
      convs[r.topic] = r.convs.map((c) => ({ conv: c.conv, title: c.title, archived: !!c.archived, last: c.last ?? null, count: c.count ?? 0, created: 0, runtime: null, busy: [] }));
    }
  }
  return { ...state, rooms: next, roomOrder: rooms.map((r) => r.topic), convs };
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'init': {
      let s = applyRooms({ ...state, ready: true, error: null, me: { device: action.device.name, human: action.device.human } }, action.rooms);
      if (action.current) s = reducer(s, { type: 'room', snapshot: action.current });
      return s;
    }
    case 'rooms':
      return applyRooms(state, action.rooms);
    case 'room': {
      const snap = action.snapshot;
      const topic = snap.topic;
      const details = { ...state.details, [topic]: detailOf(snap) };
      const convs = snap.convs ? { ...state.convs, [topic]: snap.convs } : state.convs;
      const rooms = state.rooms[topic]
        ? { ...state.rooms, [topic]: { ...state.rooms[topic], name: snap.name, folder: snap.folder ?? null, app: snap.app ?? null, convs: snap.convs ?? state.rooms[topic].convs } }
        : state.rooms;
      let threads = state.threads;
      if (snap.log && action.conv !== undefined) {
        // The snapshot's log is the page of one conversation: only trust it when we know which.
        threads = { ...threads, [convKey(topic, action.conv)]: { items: snap.log.map((r) => ({ ...r, conv: r.conv ?? 'main' })), hasOlder: !!snap.hasOlder, loaded: true } };
      }
      return { ...state, details, convs, rooms, threads };
    }
    case 'convs': {
      return { ...state, convs: { ...state.convs, [action.topic]: action.convs } };
    }
    case 'conv': {
      const list = state.convs[action.topic] ?? [];
      const i = list.findIndex((c) => c.conv === action.conv.conv);
      const next = i >= 0 ? list.map((c, j) => (j === i ? action.conv : c)) : [...list, action.conv];
      return { ...state, convs: { ...state.convs, [action.topic]: next } };
    }
    case 'select': {
      const unread = { ...state.unread };
      if (action.topic && action.conv) delete unread[convKey(action.topic, action.conv)];
      return { ...state, selected: { topic: action.topic, conv: action.conv }, unread };
    }
    case 'record': {
      const rec = { ...action.rec, conv: action.rec.conv ?? 'main' };
      if (rec.kind === 'activity') return reducer(state, { type: 'activity', topic: action.topic, rec });
      if (rec.kind !== 'msg') return state; // controls, reactions and redactions arrive folded into room/convs pushes
      const key = convKey(action.topic, rec.conv!);
      const thread = state.threads[key];
      const threads = thread ? { ...state.threads, [key]: { ...thread, items: upsert(thread.items, { ...rec, pending: false }) } } : state.threads;
      const open = state.selected.topic === action.topic && state.selected.conv === rec.conv;
      const mine = !!state.me?.human && rec.name === state.me.human;
      const known = !!thread?.items.some((x) => x.id === rec.id);
      const unread = open || mine || known ? state.unread : { ...state.unread, [key]: (state.unread[key] ?? 0) + 1 };
      return { ...state, threads, unread };
    }
    case 'log': {
      const key = convKey(action.topic, action.conv);
      const prev = state.threads[key];
      const incoming = action.log.map((r) => ({ ...r, conv: r.conv ?? action.conv }));
      if (action.mode === 'older' && prev) {
        const seen = new Set(prev.items.map((x) => x.id));
        const items = [...incoming.filter((x) => !seen.has(x.id)), ...prev.items];
        return { ...state, threads: { ...state.threads, [key]: { items, hasOlder: action.hasOlder, loaded: true, loadingOlder: false } } };
      }
      // Replace, but keep optimistic sends that have not been confirmed yet.
      const pending = prev?.items.filter((x) => x.pending && !incoming.some((y) => y.id === x.id)) ?? [];
      return { ...state, threads: { ...state.threads, [key]: { items: [...incoming, ...pending], hasOlder: action.hasOlder, loaded: true, loadingOlder: false } } };
    }
    case 'loadingOlder': {
      const key = convKey(action.topic, action.conv);
      const prev = state.threads[key];
      if (!prev) return state;
      return { ...state, threads: { ...state.threads, [key]: { ...prev, loadingOlder: action.value } } };
    }
    case 'activity': {
      const rec = { ...action.rec, conv: action.rec.conv ?? 'main' };
      const key = convKey(action.topic, rec.conv!);
      const list = state.activity[key] ?? [];
      if (list.some((x) => x.id === rec.id)) return state;
      const next = [...list, rec].slice(-MAX_ACTIVITY);
      // Activity means the seat is at work; mark it thinking until the daemon says otherwise.
      const agents = { ...state.agents, [key]: { ...(state.agents[key] ?? {}), [rec.name]: (state.agents[key]?.[rec.name] ?? 'thinking') as AgentState } };
      return { ...state, activity: { ...state.activity, [key]: next }, agents };
    }
    case 'agentState': {
      const key = convKey(action.topic, action.conv || 'main');
      return { ...state, agents: { ...state.agents, [key]: { ...(state.agents[key] ?? {}), [action.name]: action.state } } };
    }
    case 'participants': {
      const d = state.details[action.topic];
      if (!d) return state;
      return { ...state, details: { ...state.details, [action.topic]: { ...d, participants: action.participants } } };
    }
    case 'sendPending': {
      const key = convKey(action.topic, action.conv);
      const thread = state.threads[key] ?? { items: [], hasOlder: false, loaded: true };
      return { ...state, threads: { ...state.threads, [key]: { ...thread, items: [...thread.items, { ...action.rec, conv: action.conv, pending: true }] } } };
    }
    case 'sendDone': {
      const key = convKey(action.topic, action.conv);
      const thread = state.threads[key];
      if (!thread) return state;
      const rec = { ...action.rec, conv: action.rec.conv ?? action.conv, pending: false };
      const withoutLocal = thread.items.filter((x) => x.id !== action.localId);
      return { ...state, threads: { ...state.threads, [key]: { ...thread, items: upsert(withoutLocal, rec) } } };
    }
    case 'sendFailed': {
      const key = convKey(action.topic, action.conv);
      const thread = state.threads[key];
      if (!thread) return state;
      // The text goes back to the composer (the caller does that); the bubble disappears.
      return { ...state, threads: { ...state.threads, [key]: { ...thread, items: thread.items.filter((x) => x.id !== action.localId) } } };
    }
    case 'connected':
      return state.connected === action.value ? state : { ...state, connected: action.value };
    case 'error':
      return { ...state, error: action.error };
    default:
      return state;
  }
}
