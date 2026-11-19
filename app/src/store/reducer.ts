/**
 * Pure app state. Everything the shell shows derives from here; pushes and API results arrive as actions.
 */
import type { AgentState, Conversation, Device, LoginAsk, Reactions, Rec, RoomSnapshot, RoomSummary, Participant } from '../types';
import { mentions, pushFeed, type FeedItem } from './feed';

export const convKey = (topic: string, conv: string) => `${topic}/${conv}`;

export type Thread = { items: Rec[]; hasOlder: boolean; loaded: boolean; loadingOlder?: boolean };

export type RoomDetail = Pick<RoomSnapshot, 'charter' | 'seats' | 'folder' | 'app' | 'participants' | 'members' | 'reactions' | 'owner' | 'admitted'>;

export type State = {
  ready: boolean;
  connected: boolean;
  error: string | null;
  me: { device: string; ref?: string; human: string | null; canHost?: boolean } | null;
  /** The owner's devices, this one first. */
  devices: Device[];
  /** The home feed, newest first (feed.ts). */
  feed: FeedItem[];
  /** Projects another device was asked to create; `topic` is set once the room shows up. */
  pendingProjects: { id: string; name: string; asked: string; topic?: string }[];
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
  devices: [],
  feed: [],
  pendingProjects: [],
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
  | { type: 'init'; device: { name: string; ref?: string; human: string | null; canHost?: boolean }; rooms: RoomSummary[]; current?: RoomSnapshot | null }
  | { type: 'devices'; devices: Device[] }
  | { type: 'pendingProject'; id: string; name: string; asked: string }
  | { type: 'pendingDone'; id: string }
  | { type: 'feedAdd'; item: FeedItem }
  | { type: 'feedOpen'; id: string }
  | { type: 'feedOpenAll' }
  | { type: 'feedRemove'; id: string }
  | { type: 'loginAsk'; ask: LoginAsk }
  | { type: 'loginAsks'; asks: LoginAsk[] }
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
  | { type: 'reactions'; topic: string; reactions: Reactions }
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
  // A project another device was asked for: the moment a room with its name appears, remember where.
  const known = new Set(Object.keys(state.rooms));
  const pendingProjects = state.pendingProjects.length
    ? state.pendingProjects.map((p) => {
        if (p.topic) return p;
        const hit = rooms.find((r) => !known.has(r.topic) && r.name === p.name);
        return hit ? { ...p, topic: hit.topic } : p;
      })
    : state.pendingProjects;
  return { ...state, rooms: next, roomOrder: rooms.map((r) => r.topic), convs, pendingProjects };
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'init': {
      let s = applyRooms({ ...state, ready: true, error: null, me: { device: action.device.name, ref: action.device.ref, human: action.device.human, canHost: action.device.canHost } }, action.rooms);
      if (action.current) s = reducer(s, { type: 'room', snapshot: action.current });
      return s;
    }
    case 'rooms':
      return applyRooms(state, action.rooms);
    case 'devices':
      return { ...state, devices: action.devices };
    case 'pendingProject':
      return { ...state, pendingProjects: [...state.pendingProjects.filter((p) => p.id !== action.id), { id: action.id, name: action.name, asked: action.asked }] };
    case 'pendingDone':
      return { ...state, pendingProjects: state.pendingProjects.filter((p) => p.id !== action.id) };
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
      const prev = state.convs[action.topic];
      let feed = state.feed;
      if (prev && state.ready) {
        const seen = new Set(prev.map((c) => c.conv));
        for (const c of action.convs) {
          if (seen.has(c.conv) || c.archived || c.conv === 'main') continue;
          const r = state.rooms[action.topic];
          feed = pushFeed(feed, { id: `conv:${action.topic}/${c.conv}`, kind: 'conversation', ts: c.created || Date.now(), title: `New conversation: ${c.title || 'untitled'}`, where: { org: r?.app?.org ?? undefined, project: r?.name ?? '' }, topic: action.topic, conv: c.conv, unread: true });
        }
      }
      return { ...state, convs: { ...state.convs, [action.topic]: action.convs }, feed };
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
      let feed = state.feed;
      if (!mine && !known && state.ready) {
        const r = state.rooms[action.topic];
        const convTitle = (state.convs[action.topic] ?? []).find((c) => c.conv === rec.conv)?.title || (rec.conv === 'main' ? 'General' : '');
        const where = { org: r?.app?.org ?? undefined, project: r?.name ?? '', conversation: convTitle || undefined };
        const files = (rec.att ?? []).filter((a) => a.kind === 'file');
        if (mentions(rec.text, state.me?.human)) feed = pushFeed(feed, { id: `mention:${rec.id}`, kind: 'mention', ts: rec.ts, title: 'mentioned you', text: rec.text, who: rec.name, whoAgent: !rec.human, where, topic: action.topic, conv: rec.conv, unread: true });
        for (const f of files) feed = pushFeed(feed, { id: `file:${rec.id}:${f.hash}`, kind: 'file', ts: rec.ts, title: `shared ${f.name ?? 'a file'}`, text: undefined, who: rec.name, whoAgent: !rec.human, where, topic: action.topic, conv: rec.conv, unread: true });
      }
      return { ...state, threads, unread, feed };
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
      const was = state.agents[key]?.[action.name];
      let feed = state.feed;
      if (state.ready) {
        const r = state.rooms[action.topic];
        const title = (state.convs[action.topic] ?? []).find((c) => c.conv === (action.conv || 'main'))?.title || 'General';
        const where = { org: r?.app?.org ?? undefined, project: r?.name ?? '', conversation: title };
        if (action.state === 'idle' && (was === 'thinking' || was === 'waiting')) feed = pushFeed(feed, { id: `done:${key}:${action.name}:${Date.now()}`, kind: 'done', ts: Date.now(), title: 'finished', who: action.name, whoAgent: true, where, topic: action.topic, conv: action.conv || 'main', unread: true });
        if (action.state === 'error') feed = pushFeed(feed, { id: `error:${key}:${action.name}:${Date.now()}`, kind: 'error', ts: Date.now(), title: 'hit an error', who: action.name, whoAgent: true, where, topic: action.topic, conv: action.conv || 'main', unread: true });
      }
      return { ...state, feed, agents: { ...state.agents, [key]: { ...(state.agents[key] ?? {}), [action.name]: action.state } } };
    }
    case 'feedAdd':
      return { ...state, feed: pushFeed(state.feed, action.item) };
    case 'feedOpen':
      return { ...state, feed: state.feed.map((x) => (x.id === action.id && x.unread ? { ...x, unread: false } : x)) };
    case 'feedOpenAll':
      return state.feed.some((x) => x.unread && x.kind !== 'approval') ? { ...state, feed: state.feed.map((x) => (x.kind === 'approval' ? x : { ...x, unread: false })) } : state;
    case 'feedRemove':
      return { ...state, feed: state.feed.filter((x) => x.id !== action.id) };
    case 'loginAsk': {
      const a = action.ask;
      const who = a.names?.map((n) => n.name).join(', ') || 'somebody';
      return { ...state, feed: pushFeed(state.feed, { id: `ask:${a.topic}`, kind: 'approval', ts: a.at || Date.now(), title: a.room ? `wants into ${a.room}` : 'wants to log in', text: `as ${who}`, who: a.deviceName, unread: true, ask: a }) };
    }
    case 'loginAsks': {
      let feed = state.feed.filter((x) => x.kind !== 'approval' || action.asks.some((a) => a.topic === x.ask?.topic));
      for (const a of action.asks) {
        if (feed.some((x) => x.id === `ask:${a.topic}`)) continue;
        const who = a.names?.map((n) => n.name).join(', ') || 'somebody';
        feed = pushFeed(feed, { id: `ask:${a.topic}`, kind: 'approval', ts: a.at || Date.now(), title: a.room ? `wants into ${a.room}` : 'wants to log in', text: `as ${who}`, who: a.deviceName, unread: true, ask: a });
      }
      return { ...state, feed };
    }
    case 'participants': {
      const d = state.details[action.topic];
      if (!d) return state;
      return { ...state, details: { ...state.details, [action.topic]: { ...d, participants: action.participants } } };
    }
    case 'reactions': {
      const d = state.details[action.topic];
      if (!d) return state;
      return { ...state, details: { ...state.details, [action.topic]: { ...d, reactions: action.reactions } } };
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
