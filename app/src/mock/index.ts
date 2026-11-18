/**
 * In-memory daemon for `npm run dev:mock` (VITE_MOCK=1): two projects, one chat, a few conversations with
 * messages, one agent mid-turn. Simulated latency; a reply arrives a few seconds after each send.
 */
import type { Api } from '../api';
import type { EventHandlers, EventSink } from '../events';
import type { Conversation, EventName, Events, Rec, RoomSnapshot, RoomSummary, Seat, StateResponse } from '../types';

const LATENCY = 180;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let seq = 100;
const hex = () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0') + Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
const id = () => `m${(seq++).toString(16).padStart(6, '0')}${hex().slice(0, 10)}`;

type MockRoom = {
  name: string;
  topic: string;
  folder: string | null;
  app: RoomSummary['app'];
  seats: Seat[];
  charter: { text: string; order: string[]; agents: Record<string, unknown> };
  convs: Map<string, Conversation>;
  log: Rec[];
  reactions: Record<string, Record<string, string[]>>;
  participants: { name: string; role: 'human' | 'agent'; online: boolean; local: boolean }[];
};

const ME = 'guy';
const DEVICE = 'studio';

const now = Date.now();
const min = (n: number) => now - n * 60_000;

function msg(name: string, text: string, ts: number, conv: string, extra: Partial<Rec> = {}): Rec {
  return { id: id(), kind: 'msg', ts, name, human: !['rkeychat', 'claude', 'hermes', 'pearcast-agent'].includes(name), text, conv, re: [], ...extra };
}
function act(name: string, text: string, ts: number, conv: string): Rec {
  return { id: id(), kind: 'activity', ts, name, human: false, text, conv };
}

function room(opts: { name: string; folder: string | null; seats: Seat[]; charter: string; convs: { conv: string; title: string; archived?: boolean; runtime?: string | null; created: number }[]; log: Rec[] }): MockRoom {
  const convs = new Map<string, Conversation>();
  for (const c of opts.convs) convs.set(c.conv, { conv: c.conv, title: c.title, created: c.created, archived: !!c.archived, runtime: c.runtime ?? null, last: null, count: 0, busy: [] });
  const r: MockRoom = {
    name: opts.name,
    topic: hex() + hex() + hex() + hex(),
    folder: opts.folder,
    app: { app: 'rkeychat', role: opts.folder ? 'project' : 'chat', name: opts.name },
    seats: opts.seats,
    charter: { text: opts.charter, order: opts.seats.map((s) => s.name), agents: {} },
    convs,
    log: opts.log.sort((a, b) => a.ts - b.ts),
    reactions: {},
    participants: [
      { name: ME, role: 'human', online: true, local: true },
      { name: 'jeffrey', role: 'human', online: false, local: false },
      ...opts.seats.map((s) => ({ name: s.name, role: 'agent' as const, online: true, local: true })),
    ],
  };
  refreshConvs(r);
  return r;
}

function refreshConvs(r: MockRoom) {
  for (const c of r.convs.values()) {
    const msgs = r.log.filter((x) => x.kind === 'msg' && (x.conv ?? 'main') === c.conv && !x.redacted);
    const last = msgs[msgs.length - 1];
    c.last = last ? { ts: last.ts, name: last.name, text: last.text } : null;
    c.count = msgs.length;
  }
}

const peardrive = room({
  name: 'PearDrive',
  folder: '/Users/guy/Anjou/peardrive',
  seats: [{ name: 'rkeychat', bridge: 'claude', via: 'acp', dir: '/Users/guy/Anjou/peardrive' }],
  charter:
    'PearDrive is the file sharing app on pearcore. Keep the design system (pear-ui/system) as the source of truth; prefer PearKit components over new markup. Ask before touching the sync engine.',
  convs: [
    { conv: 'main', title: 'General', created: min(5000) },
    { conv: 'a1b2c3d4e5f60718', title: 'Redesign the share row', created: min(300), runtime: 'acp' },
    { conv: 'b2c3d4e5f6071829', title: 'Why does sync stall on Zorin?', created: min(140) },
    { conv: 'c3d4e5f607182930', title: 'Old: icon export script', created: min(9000), archived: true },
  ],
  log: [
    msg(ME, 'Project is up. @rkeychat you are on PearDrive now.', min(4990), 'main'),
    msg('rkeychat', 'Reading the folder. 212 files, the shell is in `src/renderer`, tests under `test/`. Ready.', min(4988), 'main'),
    msg(ME, 'Can we make the share row match the Figma: thumbnail, name, meta line, status pill on the right?', min(299), 'a1b2c3d4e5f60718'),
    msg('rkeychat', 'Yes. PearKit already has `ShareRow` with exactly that layout. I will replace the custom row in `ShareList.tsx` and delete the old styles.\n\n- `ShareRow` takes `name`, `meta`, `thumbnail`, `status`, `progress`\n- the favourite star becomes `onFavorite`', min(297), 'a1b2c3d4e5f60718'),
    act('rkeychat', 'edited src/renderer/ShareList.tsx', min(296), 'a1b2c3d4e5f60718'),
    act('rkeychat', 'ran npm test: 48 passed', min(295), 'a1b2c3d4e5f60718'),
    msg('rkeychat', 'Done: 1 file changed, 140 lines removed. Screenshot in `screens/share-row.png`. Want the progress bar to use the `transfer` gradient?', min(294), 'a1b2c3d4e5f60718'),
    msg(ME, 'Yes, the transfer gradient. And truncate long file names in the middle.', min(2), 'a1b2c3d4e5f60718'),
    act('rkeychat', 'reading src/renderer/ShareList.tsx', min(1), 'a1b2c3d4e5f60718'),
    msg('jeffrey', 'Sync sits at 98% on the Zorin box for a very long time, then finishes. Every time.', min(139), 'b2c3d4e5f6071829'),
    msg('rkeychat', 'That is the last block of the largest file waiting on a peer that went to sleep. `SyncEngine.finish()` only retries after 30 s. I can lower the retry to 5 s and log which peer it waits on.', min(137), 'b2c3d4e5f6071829'),
    msg(ME, 'Archived this one: the script lives in pearkit now.', min(8990), 'c3d4e5f607182930'),
  ],
});
peardrive.convs.get('a1b2c3d4e5f60718')!.busy = ['rkeychat'];

const pearcast = room({
  name: 'pearcast',
  folder: '/Users/guy/Anjou/pearcast',
  seats: [{ name: 'rkeychat', bridge: 'claude', via: 'cli', dir: '/Users/guy/Anjou/pearcast' }],
  charter: 'pearcast: the podcast editor. Audio first. Never touch the_editor/tool without a test.',
  convs: [
    { conv: 'main', title: 'General', created: min(20000) },
    { conv: 'd4e5f60718293a4b', title: 'Chapter markers from the transcript, a very long title that needs truncating in the sidebar', created: min(60) },
  ],
  log: [
    msg(ME, 'New project for pearcast.', min(19990), 'main'),
    msg('rkeychat', 'Here. The kit format is in `the_editor/tool/pearkit.py`; I will not confuse it with the UI library.', min(19988), 'main'),
    msg(ME, 'Can we create chapter markers from the transcript headings?', min(59), 'd4e5f60718293a4b'),
    msg('rkeychat', 'The transcript has `##` headings every few minutes. A marker per heading with its timestamp is a 40-line change in `markers.py`. Shall I?', min(58), 'd4e5f60718293a4b'),
  ],
});

const family = room({
  name: 'Family',
  folder: null,
  seats: [],
  charter: '',
  convs: [{ conv: 'main', title: 'General', created: min(100000) }],
  log: [msg('jeffrey', 'Dinner Sunday?', min(400), 'main'), msg(ME, 'Yes. I will bring the bread.', min(395), 'main')],
});
family.participants = family.participants.filter((p) => p.role === 'human');

const rooms = new Map<string, MockRoom>([peardrive, pearcast, family].map((r) => [r.topic, r]));
peardrive.reactions[peardrive.log[6].id] = { '👍': [ME] };

const summary = (r: MockRoom): RoomSummary => ({
  name: r.name,
  topic: r.topic,
  owner: true,
  admitted: true,
  folder: r.folder,
  app: r.app,
  convs: [...r.convs.values()].map(({ conv, title, archived, last, count }) => ({ conv, title, archived, last, count })),
});

const PAGE = 40;
function page(r: MockRoom, conv: string, opts: { limit?: number; before?: string } = {}) {
  const all = r.log.filter((x) => (x.conv ?? 'main') === conv);
  let end = all.length;
  if (opts.before) {
    const i = all.findIndex((x) => x.id === opts.before);
    if (i >= 0) end = i;
  }
  const limit = opts.limit ?? PAGE;
  const start = Math.max(0, end - limit);
  return { log: all.slice(start, end), hasOlder: start > 0, hasNewer: end < all.length };
}

function snapshot(r: MockRoom, conv = 'main'): RoomSnapshot {
  refreshConvs(r);
  const p = page(r, conv);
  return {
    name: r.name,
    topic: r.topic,
    owner: true,
    admitted: true,
    participants: r.participants,
    members: r.participants.map((x) => ({ name: x.name, scope: x.role === 'human' ? ['chat', 'admin'] : ['chat', 'agent'] })),
    reactions: r.reactions,
    charter: r.charter,
    log: p.log,
    hasOlder: p.hasOlder,
    convs: [...r.convs.values()],
    folder: r.folder,
    app: r.app,
    seats: r.seats,
  };
}

/* ───────────── the bus ───────────── */

const listeners = new Set<EventHandlers>();
function emit<K extends EventName>(name: K, data: Events[K]) {
  for (const h of listeners) (h[name] as ((d: Events[K]) => void) | undefined)?.(data);
}

export function mockEventSource(handlers: EventHandlers): EventSink {
  listeners.add(handlers);
  setTimeout(() => handlers.onOpen?.(false), 20);
  // The seat in the PearDrive redesign conversation is already thinking.
  setTimeout(() => emit('agent-state', { topic: peardrive.topic, name: 'rkeychat', conv: 'a1b2c3d4e5f60718', state: 'thinking' }), 400);
  return {
    close() {
      listeners.delete(handlers);
    },
    connected: true,
  };
}

const find = (key: string) => {
  const r = rooms.get(key) ?? [...rooms.values()].find((x) => x.name === key);
  if (!r) throw Object.assign(new Error(`no such room: ${key}`), { status: 404 });
  return r;
};

function pushConvs(r: MockRoom) {
  refreshConvs(r);
  emit('convs', { topic: r.topic, convs: [...r.convs.values()] });
}

async function reply(r: MockRoom, conv: string, text: string) {
  const seat = r.seats[0];
  if (!seat) return;
  await sleep(900);
  emit('agent-state', { topic: r.topic, name: seat.name, conv, state: 'thinking' });
  r.convs.get(conv)!.busy = [seat.name];
  pushConvs(r);
  await sleep(1400);
  const a = act(seat.name, `reading ${r.folder ? r.folder.split('/').pop() : 'the room'}`, Date.now(), conv);
  r.log.push(a);
  emit('activity', { topic: r.topic, rec: a });
  await sleep(1800);
  const m = msg(seat.name, text, Date.now(), conv);
  r.log.push(m);
  emit('record', { topic: r.topic, rec: m });
  emit('agent-state', { topic: r.topic, name: seat.name, conv, state: 'idle' });
  r.convs.get(conv)!.busy = [];
  pushConvs(r);
}

export const mockApi: Api = {
  async state(key, conv) {
    await sleep(LATENCY);
    const r = key ? find(key) : null;
    return {
      device: { name: DEVICE, ref: 'rkey:studio', root: 'rkey:guy', participants: [{ name: ME, role: 'human', ref: 'rkey:guy' }, { name: 'rkeychat', role: 'agent', ref: 'rkey:rkeychat', bridge: 'claude' }] },
      rooms: [...rooms.values()].map(summary),
      canTranscribe: false,
      current: r ? snapshot(r, conv ?? 'main') : null,
    } satisfies StateResponse;
  },
  async rooms() {
    await sleep(LATENCY);
    return [...rooms.values()].map(summary);
  },
  async log({ room: key, conv = 'main', limit, before }) {
    await sleep(LATENCY + 200);
    return page(find(key), conv, { limit, before });
  },
  async convs(key) {
    await sleep(LATENCY);
    return [...find(key).convs.values()];
  },
  async createConv({ room: key, title, runtime, text }) {
    await sleep(LATENCY);
    const r = find(key);
    const c: Conversation = { conv: hex(), title: title || 'New conversation', created: Date.now(), archived: false, runtime: runtime ?? null, last: null, count: 0, busy: [] };
    r.convs.set(c.conv, c);
    if (text) {
      const m = msg(ME, text, Date.now(), c.conv);
      r.log.push(m);
      setTimeout(() => emit('record', { topic: r.topic, rec: m }), 50);
    }
    setTimeout(() => pushConvs(r), 80);
    return c;
  },
  async renameConv({ room: key, conv, title }) {
    await sleep(LATENCY);
    const r = find(key);
    const c = r.convs.get(conv)!;
    c.title = title;
    setTimeout(() => pushConvs(r), 50);
    return c;
  },
  async archiveConv({ room: key, conv, archived }) {
    await sleep(LATENCY);
    const r = find(key);
    const c = r.convs.get(conv)!;
    c.archived = archived;
    setTimeout(() => pushConvs(r), 50);
    return c;
  },
  async setConvRuntime({ room: key, conv, runtime }) {
    await sleep(LATENCY);
    const r = find(key);
    const c = r.convs.get(conv)!;
    c.runtime = runtime;
    setTimeout(() => pushConvs(r), 50);
    return c;
  },
  async send({ room: key, as, text, conv, re }) {
    await sleep(LATENCY + 120);
    const r = find(key);
    const m = msg(as, text, Date.now(), conv || 'main', { re: re ?? [] });
    r.log.push(m);
    setTimeout(() => {
      emit('record', { topic: r.topic, rec: m });
      pushConvs(r);
    }, 60);
    if (/@\w+/.test(text) || r.seats.length) void reply(r, conv || 'main', `On it. (mock reply to: "${text.slice(0, 60)}")\n\nThis is **Markdown**: a list,\n\n- one\n- two\n\nand \`code\`.`);
    return m;
  },
  async search({ q, room: key }) {
    await sleep(LATENCY);
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const results = [];
    for (const r of key ? [find(key)] : rooms.values()) {
      for (const x of r.log) {
        if (x.kind !== 'msg') continue;
        if (words.every((w) => x.text.toLowerCase().includes(w))) results.push({ id: x.id, ts: x.ts, name: x.name, snippet: x.text.slice(0, 120), topic: r.topic, room: r.name, conv: x.conv });
      }
    }
    return { results: results.sort((a, b) => b.ts - a.ts) };
  },
  async activity() {
    await sleep(LATENCY);
    return [];
  },
  async createProject({ folder, name, via }) {
    await sleep(LATENCY * 3);
    const base = folder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || folder;
    const r = room({
      name: name || base,
      folder,
      seats: [{ name: 'rkeychat', bridge: 'claude', via: via ?? 'acp', dir: folder }],
      charter: '',
      convs: [{ conv: 'main', title: 'General', created: Date.now() }],
      log: [],
    });
    rooms.set(r.topic, r);
    setTimeout(() => emit('rooms', [...rooms.values()].map(summary)), 50);
    return { room: summary(r), seat: 'rkeychat' };
  },
  async bindFolder({ room: key, folder }) {
    await sleep(LATENCY);
    const r = find(key);
    r.folder = folder;
    r.app = { app: 'rkeychat', role: 'project', name: r.name };
    setTimeout(() => {
      emit('room', snapshot(r));
      emit('rooms', [...rooms.values()].map(summary));
    }, 50);
    return summary(r);
  },
  async react({ room: key, as = ME, target, emoji, on = true }) {
    await sleep(LATENCY);
    const r = find(key);
    const names = new Set(r.reactions[target]?.[emoji] ?? []);
    if (on) names.add(as);
    else names.delete(as);
    r.reactions[target] = { ...(r.reactions[target] ?? {}), [emoji]: [...names] };
    if (!names.size) delete r.reactions[target][emoji];
    setTimeout(() => emit('room', snapshot(r)), 50);
    return { id: id(), kind: 'react', ts: Date.now(), name: as, text: emoji };
  },
  async charter({ room: key, text, order, agents }) {
    await sleep(LATENCY);
    const r = find(key);
    r.charter = { text, order, agents };
    setTimeout(() => emit('room', snapshot(r)), 50);
    return { ok: true };
  },
  async setAgentVia({ name, via }) {
    await sleep(LATENCY);
    for (const r of rooms.values()) for (const s of r.seats) if (s.name === name) s.via = via;
    for (const r of rooms.values()) if (r.seats.some((s) => s.name === name)) emit('room', snapshot(r));
    return { ok: true };
  },
};
