/**
 * In-memory daemon for `npm run dev:mock` (VITE_MOCK=1): two projects, one chat, a few conversations with
 * messages, one agent mid-turn. Simulated latency; a reply arrives a few seconds after each send.
 */
import { ApiError, type Api } from '../api';
import type { EventHandlers, EventSink } from '../events';
import type { AgentRule, Conversation, DebugNoteSync, Device, EventName, OpenAsk, Events, FileEntry, PendingRequest, Provider, Rec, RoomSnapshot, RoomSummary, Seat, StateResponse } from '../types';

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
  charter: { text: string; order: string[]; agents: Record<string, AgentRule> };
  org: string | null;
  files: FileEntry[];
  convs: Map<string, Conversation>;
  log: Rec[];
  reactions: Record<string, Record<string, string[]>>;
  participants: { name: string; role: 'human' | 'agent'; online: boolean; local: boolean }[];
};

const ME = 'guy';
const DEVICE = 'studio';
const HERE = 'rkey:studio';
const DEVICES: Device[] = [
  // A touch device plays the phone: it cannot hold a project folder.
  { ref: HERE, name: DEVICE, online: true, here: true, canHost: !(typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches) },
  { ref: 'rkey:macbook', name: 'macbook', online: true, here: false },
  { ref: 'rkey:zorin', name: 'zorin', online: false, here: false },
];
let workspace = '/Users/guy/Projects';
// projects asked of other devices: answered when a room's app note names the request
const requests: PendingRequest[] = [];
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';

const now = Date.now();
const min = (n: number) => now - n * 60_000;

function msg(name: string, text: string, ts: number, conv: string, extra: Partial<Rec> = {}): Rec {
  return { id: id(), kind: 'msg', ts, name, human: !['rkeychat', 'claude', 'hermes', 'pearcast-agent'].includes(name), text, conv, re: [], ...extra };
}
function act(name: string, text: string, ts: number, conv: string): Rec {
  return { id: id(), kind: 'activity', ts, name, human: false, text, conv };
}

function room(opts: { name: string; folder: string | null; org?: string | null; home?: { device: string; name: string } | null; seats: Seat[]; charter: string; convs: { conv: string; title: string; archived?: boolean; runtime?: string | null; created: number }[]; log: Rec[] }): MockRoom {
  const convs = new Map<string, Conversation>();
  for (const c of opts.convs) convs.set(c.conv, { conv: c.conv, title: c.title, created: c.created, archived: !!c.archived, runtime: c.runtime ?? null, last: null, count: 0, busy: [] });
  const r: MockRoom = {
    name: opts.name,
    topic: hex() + hex() + hex() + hex(),
    folder: opts.folder,
    app: { app: 'rkeychat', role: opts.folder || opts.home ? 'project' : 'chat', name: opts.name, org: opts.org ?? null, home: opts.home === undefined ? (opts.folder ? { device: HERE, name: DEVICE } : null) : opts.home },
    org: opts.org ?? null,
    files: [],
    seats: opts.seats,
    charter: { text: opts.charter, order: opts.seats.map((s) => s.name), agents: Object.fromEntries(opts.seats.map((s) => [s.name, { role: 'Keeps the design system honest.', wake: 'order' as const, tokensPerDay: 200000 }])) },
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
  org: 'Anjou',
  folder: '/Users/guy/Anjou/peardrive',
  seats: [{ name: 'rkeychat', bridge: 'claude', via: 'acp', dir: '/Users/guy/Anjou/peardrive', permissionMode: 'acceptEdits', model: null, provider: null, askMinutes: null, providers: [{ name: 'ppq', hasToken: true }] }],
  charter:
    'PearDrive is the file sharing app on pearcore. Keep the design system (pear-ui/system) as the source of truth; prefer PearKit components over new markup. Ask before touching the sync engine.',
  convs: [
    { conv: 'main', title: 'General', created: min(5000) },
    { conv: 'a1b2c3d4e5f60718', title: 'Redesign the share row', created: min(300), runtime: 'acp' },
    { conv: 'b2c3d4e5f6071829', title: 'Why does sync stall on Zorin?', created: min(140) },
    { conv: 'c3d4e5f607182930', title: 'Old: icon export script', created: min(9000), archived: true },
    { conv: 'e5f60718293a4b5c', title: 'The long one', created: min(2000) },
  ],
  log: [
    msg(ME, 'Project is up. @rkeychat you are on PearDrive now.', min(4990), 'main'),
    msg('rkeychat', 'Reading the folder. 212 files, the shell is in `src/renderer`, tests under `test/`. Ready.', min(4988), 'main'),
    // the seat asking for a permission its tool list does not settle: open, nine minutes left
    { id: 'ask0000000000000001', kind: 'ask', ts: min(1), name: 'rkeychat', human: false, text: '', conv: 'main', tool: 'Bash', what: 'npm run release -- --tag 0.4.0', input: 'npm run release -- --tag 0.4.0 && git push origin v0.4.0', options: [{ id: 'o1', kind: 'allow_once' }, { id: 'o2', kind: 'allow_always' }, { id: 'o3', kind: 'reject_once' }], expires: Date.now() + 9 * 60_000 },
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
    // a conversation taller than any screen: what scrolling, the keyboard and arriving replies are tested against
    ...Array.from({ length: 40 }, (_, i) =>
      i % 2
        ? msg('rkeychat', `Step ${i}: ${['checked the renderer', 'ran the tests', 'moved the row into PearKit', 'wrote the story'][i % 4]}, nothing else touched. Next?`, min(1990 - i * 3), 'e5f60718293a4b5c')
        : msg(ME, `Note ${i}: keep going, and show me the diff when the share row is in.`, min(1990 - i * 3), 'e5f60718293a4b5c'),
    ),
  ],
});
peardrive.convs.get('a1b2c3d4e5f60718')!.busy = ['rkeychat'];

const pearcast = room({
  name: 'pearcast',
  org: 'Anjou',
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

const notes = room({
  name: 'Notes',
  folder: null,
  home: { device: 'rkey:macbook', name: 'macbook' },
  seats: [{ name: 'rkeychat', bridge: 'claude', via: 'acp', dir: null }],
  charter: 'Daily notes. Keep them short.',
  convs: [{ conv: 'main', title: 'General', created: min(3000) }],
  log: [msg(ME, 'Started this one from the phone; it lives on the MacBook.', min(2990), 'main')],
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

const mockNotes: { id: string; startedAt?: string; seconds?: number; steps?: number; where?: Record<string, unknown>; audio?: string | null }[] = [
  { id: '2026-11-18T21-04-12', startedAt: new Date(min(1300)).toISOString(), seconds: 41, steps: 12, where: { page: 'conversation', project: 'PearDrive', conversation: 'Redesign the share row' }, audio: 'note.webm' },
  { id: '2026-11-19T09-40-03', startedAt: new Date(min(60)).toISOString(), seconds: 9, steps: 4, where: { page: 'home' }, audio: null },
];
const noteSavedAt = new Map<string, number>(); // when a note was saved here (the sync bubble's clock); older notes count as long fetched
const MAC_KEY = '0431eed5ea51a96bb00eb76482a30f0a050c5625fd98bc6fc73fa15f61bfa3da';
const rooms = new Map<string, MockRoom>([peardrive, pearcast, notes, family].map((r) => [r.topic, r]));
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
peardrive.files = [
  { hash: 'a1f9c2d4e5b6a7c8d9e0f1a2b3c4d5e6', kind: 'file', name: 'share-row.png', mime: 'image/png', size: 184320, by: 'rkeychat', ts: min(294), local: true, providers: 2 },
  { hash: 'b2e8d3c5f6a7b8c9d0e1f2a3b4c5d6e7', kind: 'file', name: 'sync-trace.log', mime: 'text/plain', size: 52311, by: 'jeffrey', ts: min(138), local: false, providers: 1 },
];
peardrive.log[6].att = [{ hash: 'a1f9c2d4e5b6a7c8d9e0f1a2b3c4d5e6', kind: 'file', name: 'share-row.png', mime: 'image/png', size: 184320 }];

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
    ownerDevice: true,
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
  // Someone at the door, and a mention, so the home feed has something to show.
  setTimeout(() => emit('login-ask', { topic: 'ask-1', device: 'rkey:phone2', deviceName: 'guy-phone', names: [{ name: 'guy', role: 'human' }], room: null, action: 'login', at: Date.now() }), 900);
  setTimeout(() => {
    const m = msg('rkeychat', '@guy the Zorin fix is in: retry at 5 s, the slow peer is logged. Want a release?', Date.now(), 'b2c3d4e5f6071829');
    peardrive.log.push(m);
    emit('record', { topic: peardrive.topic, rec: m });
    refreshConvs(peardrive);
    emit('convs', { topic: peardrive.topic, convs: [...peardrive.convs.values()] });
  }, 1400);
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
      device: { name: DEVICE, ref: HERE, root: 'rkey:guy', canHost: DEVICES[0].canHost, participants: [{ name: ME, role: 'human', ref: 'rkey:guy' }, { name: 'rkeychat', role: 'agent', ref: 'rkey:rkeychat', bridge: 'claude' }] },
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
  async createProject({ folder, name, home, prompt, org, via }) {
    await sleep(LATENCY * 3);
    const dev = home ? DEVICES.find((d) => d.ref === home || d.name === home) : DEVICES[0];
    if (!dev) throw Object.assign(new Error(`no such device: ${home}`), { status: 404 });
    if (!name && !folder) throw Object.assign(new Error('a project needs a name'), { status: 400 });
    const base = folder ? folder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || folder : '';
    const make = (where: Device, dir: string | null) =>
      room({
        name: name || base,
        folder: dir,
        org: org ?? null,
        home: { device: where.ref, name: where.name },
        seats: [{ name: 'rkeychat', bridge: 'claude', via: via ?? 'acp', dir }],
        charter: prompt ?? '',
        convs: [{ conv: 'main', title: 'General', created: Date.now() }],
        log: [],
      });
    if (!dev.here) {
      // Another device: a signed request goes out; the room shows up in a later `rooms` push (3 s here),
      // its app note naming the request. An offline device answers only when it comes back (never, here).
      const id = hex().slice(0, 24);
      requests.push({ id, name: name || base, asked: dev.name, home: dev.ref, via: 'Family', ts: Date.now(), online: dev.online });
      if (dev.online) {
        setTimeout(() => {
          const r = make(dev, null);
          r.app = r.app ? { ...r.app, request: id } : r.app;
          rooms.set(r.topic, r);
          emit('rooms', [...rooms.values()].map(summary));
        }, 3000);
      }
      return { pending: true as const, asked: dev.name, via: 'Family', id, online: dev.online };
    }
    const r = make(dev, folder ?? `${workspace}/${slug(name || base)}`);
    rooms.set(r.topic, r);
    setTimeout(() => emit('rooms', [...rooms.values()].map(summary)), 50);
    return { room: summary(r), seat: 'rkeychat' };
  },
  async devices() {
    await sleep(LATENCY);
    return DEVICES;
  },
  async pendingProjects() {
    await sleep(LATENCY);
    const answered = new Set([...rooms.values()].map((r) => r.app?.request).filter(Boolean));
    return requests.filter((p) => !answered.has(p.id));
  },
  async renameRoom({ room: key, name }) {
    await sleep(LATENCY);
    const r = find(key);
    r.name = name;
    if (r.app) r.app = { ...r.app, name };
    setTimeout(() => emit('rooms', [...rooms.values()].map(summary)), 50);
    return { ok: true };
  },
  async setRoomOrg({ room: key, org }) {
    await sleep(LATENCY);
    const r = find(key);
    r.org = org && org.trim() ? org.trim() : null;
    if (r.app) r.app = { ...r.app, org: r.org };
    setTimeout(() => emit('rooms', [...rooms.values()].map(summary)), 50);
    return summary(r);
  },
  async removeRoom({ room: key }) {
    await sleep(LATENCY);
    const r = find(key);
    rooms.delete(r.topic);
    setTimeout(() => emit('rooms', [...rooms.values()].map(summary)), 50);
    return { removed: true, topic: r.topic, seats: r.seats.map((s) => s.name), folder: r.folder };
  },
  async files(key) {
    await sleep(LATENCY);
    return [...find(key).files].sort((a, b) => b.ts - a.ts);
  },
  async fetchFile({ room: key, hash }) {
    await sleep(LATENCY * 4);
    const r = find(key);
    const f = r.files.find((x) => x.hash.startsWith(hash));
    if (!f) throw Object.assign(new Error('no such file in this room'), { status: 404 });
    f.local = true;
    return { ...f, path: `/Users/guy/.rkeychat/cache/${f.hash.slice(0, 12)}-${f.name}` };
  },
  async invite(key) {
    await sleep(LATENCY);
    const r = find(key);
    return { invite: `rkeychat-invite:${r.topic.slice(0, 40)}…`, room: r.name };
  },
  async people() {
    await sleep(LATENCY);
    return { local: [{ name: 'rkeychat', role: 'agent', local: true }], known: [{ name: 'jeffrey', role: 'human', from: 'Family' }, { name: 'kimi-mini', role: 'agent', from: 'PearDrive' }] };
  },
  async agents() {
    await sleep(LATENCY);
    return [{ name: 'rkeychat', bridge: 'claude', via: 'acp', dir: '/Users/guy/Anjou/peardrive', rooms: [...rooms.values()].filter((r) => r.seats.length).map((r) => ({ name: r.name, topic: r.topic, enrolled: true, state: 'idle' as const, busy: false })) }];
  },
  async asks() {
    await sleep(LATENCY);
    const asks: OpenAsk[] = [];
    for (const r of rooms.values()) for (const x of r.log) if (x.kind === 'ask' && (x.expires ?? 0) > Date.now() && !r.log.some((y) => y.kind === 'control' && y.action === 'answer' && y.ask === x.id)) asks.push({ ...x, topic: r.topic, room: r.name } as OpenAsk);
    return { asks };
  },
  async answerAsk({ room: key, ask, choice }) {
    await sleep(LATENCY);
    const r = find(key);
    const a = r.log.find((x) => x.kind === 'ask' && x.id === ask);
    if (!a) throw new Error('no such ask in this room');
    if (r.log.some((y) => y.kind === 'control' && y.action === 'answer' && y.ask === ask)) throw new Error('already answered');
    const rec: Rec = { id: id(), kind: 'control', action: 'answer', ts: Date.now(), name: ME, device: DEVICE, human: true, text: '', conv: a.conv ?? 'main', ask, choice };
    r.log.push(rec);
    setTimeout(() => emit('record', { topic: r.topic, rec }), 60);
    return rec;
  },
  async loginAsks() {
    await sleep(LATENCY);
    return { asking: [] };
  },
  async loginGrant() {
    await sleep(LATENCY);
    return { granted: 'guy-phone' };
  },
  async debugNotes() {
    await sleep(LATENCY);
    return { dir: '/Users/guy/.rkeychat/debug', sharelink: 'peardrive://debug-notes-7e9558905c031c7a647a', topic: 'debug', count: mockNotes.length, notes: [...mockNotes].reverse() };
  },
  async debugSaveNote({ id, audio, trace, meta }) {
    await sleep(LATENCY * 2);
    mockNotes.push({ id, ...(meta as object), steps: trace.length, audio: audio ? 'note.webm' : null });
    noteSavedAt.set(id, Date.now());
    return { id, files: ['trace.jsonl', 'note.json'], shared: true, sharelink: 'peardrive://debug-notes-7e9558905c031c7a647a' };
  },
  // The Mac is on the notes space; a note just saved is fetched over about three seconds (the bubble's states)
  async debugSync() {
    await sleep(LATENCY / 2);
    const notes: Record<string, DebugNoteSync> = {};
    for (const n of mockNotes) {
      const age = Date.now() - (noteSavedAt.get(n.id) ?? 0);
      const files = n.audio ? 3 : 2;
      const got = age < 1200 ? -1 : age < 2200 ? 1 : age < 3200 ? files - 1 : files;
      notes[n.id] = got < 0 ? { files, state: 'local', by: {} } : { files, state: got >= files ? 'fetched' : 'fetching', by: { [MAC_KEY]: { name: 'macbook', got, of: files } } };
    }
    return { connected: true, peers: 1, readers: [{ key: MAC_KEY, name: 'macbook' }], notes };
  },
  async debugShare({ id }) {
    await sleep(LATENCY);
    return { ok: true, id };
  },
  async loginDeny() {
    await sleep(LATENCY);
    return { denied: 'guy-phone' };
  },
  async workspace() {
    await sleep(LATENCY);
    return { workspace };
  },
  async setWorkspace({ workspace: w }) {
    await sleep(LATENCY);
    workspace = w;
    return { workspace };
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
  // the bot's settings: the request lands in the log, the "host" applies it and its echo refreshes the snapshot
  async seatControl({ room: key, agent, seat }) {
    await sleep(LATENCY);
    const r = find(key);
    const s = r.seats.find((x) => x.name === agent);
    if (!s) throw new ApiError(400, 'which seat?');
    if (seat.permissionMode === ('bypassPermissions' as never)) throw new ApiError(400, 'bypassPermissions is never used for a seat');
    if (seat.provider && !mockProviders.some((p) => p.name === seat.provider)) throw new ApiError(400, `no provider "${seat.provider}" on this device`);
    const req: Rec = { id: id(), kind: 'control', action: 'seat', ts: Date.now(), name: ME, device: DEVICE, human: true, text: '', conv: 'main', agent, seat: { ...seat } };
    r.log.push(req);
    emit('record', { topic: r.topic, rec: req });
    const change = { ...seat };
    delete change.applied;
    Object.assign(s, change);
    s.providers = mockProviders.map(({ name, hasToken }) => ({ name, hasToken }));
    const echo: Rec = { id: id(), kind: 'control', action: 'seat', ts: Date.now() + 1, name: ME, device: DEVICE, human: true, text: '', conv: 'main', agent, seat: { applied: true, permissionMode: s.permissionMode, model: s.model ?? null, provider: s.provider ?? null, askMinutes: s.askMinutes ?? null, via: s.via ?? 'acp', dir: s.dir, providers: s.providers } };
    r.log.push(echo);
    setTimeout(() => {
      emit('record', { topic: r.topic, rec: echo });
      emit('room', snapshot(r));
    }, 60);
    return req;
  },
  async providers() {
    await sleep(LATENCY);
    return { providers: mockProviders.map((p) => ({ ...p })) };
  },
  async setProvider({ name, baseUrl, token }) {
    await sleep(LATENCY);
    const cur = mockProviders.find((p) => p.name === name);
    const next: Provider = { name, baseUrl: baseUrl ?? cur?.baseUrl ?? null, hasToken: !!token || !!cur?.hasToken };
    if (cur) Object.assign(cur, next);
    else mockProviders.push(next);
    return { ...next };
  },
  async removeProvider({ name }) {
    await sleep(LATENCY);
    const i = mockProviders.findIndex((p) => p.name === name);
    if (i < 0) throw new ApiError(400, `no provider "${name}" on this device`);
    mockProviders.splice(i, 1);
    return { removed: name };
  },
};

const mockProviders: Provider[] = [{ name: 'ppq', baseUrl: 'https://api.ppq.ai', hasToken: true }];
