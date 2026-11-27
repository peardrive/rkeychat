/**
 * In-memory daemon for `npm run dev:mock` (VITE_MOCK=1): two projects, one chat, a few conversations with
 * messages, one agent mid-turn. Simulated latency; a reply arrives a few seconds after each send.
 */
import { ApiError, type Api } from '../api';
import type { EventHandlers, EventSink } from '../events';
import type { AgentRule, AutoLimit, Budget, ClaudeLoginState, ClaudeStatus, Conversation, DebugNoteSync, Device, EventName, OpenAsk, Events, FileEntry, PendingRequest, Provider, ProviderPreset, Rec, ReleaseInfo, RoomSnapshot, RoomSummary, Seat, SetupInfo, StateResponse, UpdateJob, UpdateVersionInfo, UpdatesState } from '../types';

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
  autoCap?: AutoLimit | null;
  budget?: Budget;
};

const freshBudget = (): Budget => ({ paused: false, unlimited: false, until: null, rounds: 3, limit: 3, remaining: 3, agents: { paused: [], limits: {}, posts: {} } });

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
const following: string[] = [];
const rooms = new Map<string, MockRoom>([peardrive, pearcast, notes, family].map((r) => [r.topic, r]));
peardrive.reactions[peardrive.log[6].id] = { '👍': [ME] }; // emoji-ok: a reaction

const summary = (r: MockRoom): RoomSummary => ({
  name: r.name,
  topic: r.topic,
  owner: true,
  admitted: true,
  folder: r.folder,
  app: r.app,
  convs: [...r.convs.values()].map(({ conv, title, archived, last, count }) => ({ conv, title, archived, last, count })),
});
// a picture with real bytes for the tiles and the viewer: a small PNG drawn on a canvas (react-native-web's image
// loader does not take an SVG data URL)
const PIC = (hue: number, w = 640, h = 480): string => {
  if (typeof document === 'undefined') return '';
  const c = document.createElement('canvas');
  c.width = Math.round(w / 4);
  c.height = Math.round(h / 4);
  const g = c.getContext('2d');
  if (!g) return '';
  g.fillStyle = `hsl(${hue} 45% 38%)`;
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = `hsl(${hue + 40} 70% 72%)`;
  g.beginPath();
  g.arc(c.width / 2, c.height / 2, Math.min(c.width, c.height) / 4, 0, Math.PI * 2);
  g.fill();
  return c.toDataURL('image/png');
};
peardrive.files = [
  { hash: 'a1f9c2d4e5b6a7c8d9e0f1a2b3c4d5e6', kind: 'file', name: 'share-row.png', mime: 'image/png', size: 184320, by: 'rkeychat', ts: min(294), local: true, providers: 2, w: 1280, h: 800, url: PIC(90, 1280, 800) },
  { hash: 'b2e8d3c5f6a7b8c9d0e1f2a3b4c5d6e7', kind: 'file', name: 'sync-trace.log', mime: 'text/plain', size: 52311, by: 'jeffrey', ts: min(138), local: false, providers: 1 },
];
// the message that shared a picture, found by its words (an index moved once when the ask was added, and the picture
// landed on an activity line nobody could see, 2026-11-25)
const shared = peardrive.log.find((r) => r.kind === 'msg' && r.text?.startsWith('Done: 1 file changed'))!;
shared.att = [{ hash: 'a1f9c2d4e5b6a7c8d9e0f1a2b3c4d5e6', kind: 'file', name: 'share-row.png', mime: 'image/png', size: 184320, w: 1280, h: 800, url: PIC(90, 1280, 800) }];
// three pictures and a file in one message, right after it: the gallery
peardrive.log.splice(peardrive.log.indexOf(shared) + 1, 0, msg('rkeychat', 'Three looks for the row, and the measurements.', shared.ts + 30_000, shared.conv ?? 'main', { att: [
  { hash: 'c3e1a2b4d5f60718293a4b5c6d7e8f90', kind: 'file', name: 'row-a.png', mime: 'image/png', size: 120_000, w: 800, h: 600, url: PIC(20, 800, 600) },
  { hash: 'd4f2b3c5e6071829304b5c6d7e8f9a01', kind: 'file', name: 'row-b.png', mime: 'image/png', size: 130_000, w: 800, h: 600, url: PIC(200, 800, 600) },
  { hash: 'e5a3c4d6f708192a3b4c5d6e7f8a9b12', kind: 'file', name: 'row-c.png', mime: 'image/png', size: 110_000, w: 600, h: 800, url: PIC(300, 600, 800) },
  { hash: 'f6b4d5e708192a3b4c5d6e7f8a9b0c23', kind: 'file', name: 'measurements.pdf', mime: 'application/pdf', size: 48_000, url: 'data:application/pdf;base64,JVBERi0=' },
] }));

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
    autoCap: r.autoCap ?? null,
    budget: r.budget ?? (r.budget = freshBudget()),
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
  async debugFollow({ link }) {
    await sleep(LATENCY);
    if (!/^pearcore:\/\//.test(link)) throw new ApiError(400, "that isn't a pearcore link");
    const host = `device-${following.length + 1}`;
    following.push(host);
    return { host, following: [...following] };
  },
  async debugUnfollow({ host }) {
    await sleep(LATENCY);
    const i = following.indexOf(host);
    if (i < 0) throw new ApiError(400, `not following ${host}`);
    following.splice(i, 1);
    return { host, following: [...following] };
  },
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
    delete change.auto;
    const prev = s.permissionMode ?? 'acceptEdits';
    Object.assign(s, change);
    // Auto takes a grant and remembers the mode to go back to; leaving Auto drops it
    if (seat.permissionMode === 'auto' || seat.auto !== undefined) {
      s.permissionMode = 'auto';
      s.auto = { since: Date.now(), minutes: seat.auto?.minutes ?? null, turns: seat.auto?.turns ?? null, used: 0, back: prev === 'auto' ? s.auto?.back ?? 'default' : prev };
    } else if (seat.permissionMode !== undefined) s.auto = null;
    s.providers = mockProviders.map(({ name, hasToken }) => ({ name, hasToken }));
    const echo: Rec = { id: id(), kind: 'control', action: 'seat', ts: Date.now() + 1, name: ME, device: DEVICE, human: true, text: '', conv: 'main', agent, seat: { applied: true, permissionMode: s.permissionMode, auto: s.auto ?? null, model: s.model ?? null, provider: s.provider ?? null, askMinutes: s.askMinutes ?? null, via: s.via ?? 'acp', dir: s.dir, providers: s.providers } };
    r.log.push(echo);
    setTimeout(() => {
      emit('record', { topic: r.topic, rec: echo });
      emit('room', snapshot(r));
    }, 60);
    return req;
  },
  async autoCap({ room: key, auto }) {
    await sleep(LATENCY);
    const r = find(key);
    const cap = { minutes: auto.minutes || null, turns: auto.turns || null };
    r.autoCap = cap.minutes == null && cap.turns == null ? null : cap;
    const rec: Rec = { id: id(), kind: 'control', action: 'auto', ts: Date.now(), name: ME, device: DEVICE, human: true, text: '', conv: 'main', auto: cap };
    r.log.push(rec);
    emit('record', { topic: r.topic, rec });
    setTimeout(() => emit('room', snapshot(r)), 40);
    return rec;
  },
  // the round budget, as src/turns.js would compute it from the controls
  async rounds({ room: key, action, n, hours }) {
    await sleep(LATENCY);
    const r = find(key);
    const b = (r.budget ??= freshBudget());
    const used = b.limit - (b.remaining ?? b.limit);
    if (action === 'rounds') {
      if (!Number.isInteger(Number(n)) || Number(n) < 0 || Number(n) > 1000) throw new ApiError(400, 'rounds: a whole number, 1 to 1000 (0 puts the default back)');
      b.rounds = Math.max(1, Number(n) || 3);
      b.limit = b.rounds;
      b.unlimited = false;
      b.until = null;
    } else if (action === 'extend') b.limit += Math.max(1, Number(n) || 1);
    else if (action === 'unlimited') b.unlimited = true;
    else if (action === 'until') b.until = Date.now() + (Number(hours) || 8) * 3600_000;
    else if (action === 'reset') Object.assign(b, { rounds: 3, limit: 3, unlimited: false, until: null });
    b.remaining = b.unlimited || (b.until && b.until > Date.now()) ? null : Math.max(0, b.limit - used);
    const rec: Rec = { id: id(), kind: 'control', action, ts: Date.now(), name: ME, device: DEVICE, human: true, text: '', conv: 'main', n: action === 'rounds' || action === 'extend' ? Number(n) || 0 : undefined, until: b.until ?? undefined } as Rec;
    r.log.push(rec);
    emit('record', { topic: r.topic, rec, budget: b });
    setTimeout(() => emit('room', snapshot(r)), 40);
    return rec;
  },
  async agentLimit({ room: key, agent, n }) {
    await sleep(LATENCY);
    const r = find(key);
    if (!r.seats.some((s) => s.name === agent)) throw new ApiError(400, 'which agent?');
    const b = (r.budget ??= freshBudget());
    if (Number(n) > 0) b.agents.limits[agent] = Number(n);
    else delete b.agents.limits[agent];
    const rec: Rec = { id: id(), kind: 'control', action: 'limit', ts: Date.now(), name: ME, device: DEVICE, human: true, text: '', conv: 'main', agent, n: Number(n) || 0 } as Rec;
    r.log.push(rec);
    emit('record', { topic: r.topic, rec, budget: b });
    setTimeout(() => emit('room', snapshot(r)), 40);
    return rec;
  },
  async providers() {
    await sleep(LATENCY);
    return { providers: mockProviders.map((p) => ({ ...p })), presets: PRESETS };
  },
  async setProvider({ name, baseUrl, token }) {
    await sleep(LATENCY);
    const cur = mockProviders.find((p) => p.name === name);
    const preset = PRESETS[name] ? name : Object.keys(PRESETS).find((k) => PRESETS[k].baseUrl === (baseUrl ?? cur?.baseUrl)) ?? null;
    const hasToken = !!token || !!cur?.hasToken;
    const next: Provider = { name, baseUrl: baseUrl ?? cur?.baseUrl ?? null, hasToken, preset, label: preset ? PRESETS[preset].label : name, ready: hasToken || (!!preset && PRESETS[preset].key === 'none') };
    if (cur) Object.assign(cur, next);
    else mockProviders.push(next);
    return { ...next };
  },
  async setup() {
    await sleep(LATENCY);
    return setupInfo();
  },
  async saveSetup({ agent, done }) {
    await sleep(LATENCY);
    if (agent !== undefined) {
      if (agent && agent !== 'claude' && !mockProviders.some((p) => p.name === agent)) throw new ApiError(400, `no provider "${agent}" on this device`);
      setup.agent = agent || null;
    }
    if (done !== undefined) setup.done = done;
    const info = setupInfo();
    setTimeout(() => emit('setup', info), 10);
    return info;
  },
  async claude() {
    await sleep(LATENCY);
    return { ...claudeStatus, login: { ...claudeLogin } };
  },
  async claudeLogin() {
    await sleep(LATENCY);
    if (claudeLogin.running) return { ...claudeLogin };
    // the CLI: the browser URL is known at once, then it waits for the code the page shows
    claudeLogin = { running: true, url: null, waitingForCode: false, error: null, done: false };
    setTimeout(() => { claudeLogin = { ...claudeLogin, url: 'https://claude.com/cai/oauth/authorize?code=true&state=mock' }; emit('claude', { ...claudeLogin }); }, 250);
    setTimeout(() => { if (claudeLogin.running) { claudeLogin = { ...claudeLogin, waitingForCode: true }; emit('claude', { ...claudeLogin }); } }, 500);
    return { ...claudeLogin };
  },
  async claudeLoginCode({ code }) {
    await sleep(LATENCY);
    if (!claudeLogin.running) throw new ApiError(400, 'no login is in progress; start one first');
    const ok = code.trim().length >= 4;
    claudeLogin = { running: false, url: null, waitingForCode: false, error: ok ? null : 'Error: invalid code', done: ok };
    if (ok) claudeStatus = { loggedIn: true, method: 'claude.ai', email: 'ben@example.com', plan: 'pro' };
    setTimeout(() => { emit('claude', { ...claudeLogin }); emit('setup', setupInfo()); }, 10);
    return { ...claudeLogin };
  },
  async claudeLoginCancel() {
    claudeLogin = { running: false, url: null, waitingForCode: false, error: null, done: false };
    setTimeout(() => emit('claude', { ...claudeLogin }), 10);
    return { ...claudeLogin };
  },
  async claudeLogout() {
    await sleep(LATENCY);
    claudeStatus = { loggedIn: false, method: 'none' };
    setTimeout(() => emit('setup', setupInfo()), 10);
    return { ...claudeStatus };
  },
  async updates() {
    await sleep(LATENCY);
    return updatesState();
  },
  async updatesCheck() {
    await sleep(LATENCY * 2);
    return updatesState();
  },
  async updatesDownload({ id }) {
    await sleep(LATENCY);
    return mockDownload(id);
  },
  async updatesInstall({ id }) {
    await sleep(LATENCY);
    const s = await mockDownload(id);
    if (s.job.state !== 'ready') return s;
    updJob = { ...updJob, state: 'installing' };
    setTimeout(() => emit('updates', updatesState()), 10);
    return updatesState();
  },
  async updatesChannel({ reset }) {
    await sleep(LATENCY);
    if (reset) updJob = { state: 'idle' };
    return updatesState();
  },
  async updatesRelease(id) {
    await sleep(LATENCY);
    const v = mockVersions.find((x) => x.id === id);
    if (!v) throw new ApiError(404, 'no such release');
    const r: ReleaseInfo = { app: 'rkeychat-desktop', channel: 'release', version: v.version, build: v.build, commit: 'abc1234', os: 'mac', arch: 'arm64', ext: 'zip', file: v.file, size: v.size ?? 0, sha256: v.id.padEnd(64, '0'), notes: v.notes, publishedAt: new Date(v.at).toISOString(), publisher: MOCK_PUBLISHER, sig: 'ab'.repeat(64), verified: true, signedBy: MOCK_PUBLISHER };
    return r;
  },
  async removeProvider({ name }) {
    await sleep(LATENCY);
    const i = mockProviders.findIndex((p) => p.name === name);
    if (i < 0) throw new ApiError(400, `no provider "${name}" on this device`);
    mockProviders.splice(i, 1);
    return { removed: name };
  },
};

// ---- in-app updates (docs/updates.md): this copy is 0.3.1; 0.3.2 waits on the channel unless ?updates=none ----
const UPDATES_NONE = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('updates') === 'none';
const MOCK_PUBLISHER = 'ed25519:' + '5a'.repeat(32);
const RUNNING = { version: '0.3.1', build: '2026-11-25.1', commit: 'abc1234', from: '/Applications/rKeyChat.app', source: false, desktop: true };
const mockVersions: UpdateVersionInfo[] = [
  { id: 'r032', version: '0.3.2', build: '2026-11-25.2', at: now - 2 * 3600_000, size: 412_556_924, notes: 'Updates arrive through the channel and install with one press; the previous copy is kept for the way back.', file: 'rkeychat-desktop-0.3.2-mac-arm64.zip' },
  { id: 'r031', version: '0.3.1', build: '2026-11-25.1', at: now - 26 * 3600_000, size: 412_120_311, notes: 'The first build on the update channel.', file: 'rkeychat-desktop-0.3.1-mac-arm64.zip' },
  { id: 'r030', version: '0.3.0', build: '2026-11-24.1', at: now - 50 * 3600_000, size: 411_837_611, notes: 'First run: name, Connect your AI, where projects live.', file: 'rkeychat-desktop-0.3.0-mac-arm64.zip' },
];
let updJob: UpdateJob = { state: 'idle' };
function updatesState(): UpdatesState {
  const versions = UPDATES_NONE ? mockVersions.slice(1) : mockVersions;
  const pending = versions.filter((v) => v.version > RUNNING.version);
  const status = updJob.state === 'installing' ? 'installing' : updJob.state === 'downloading' ? 'downloading' : pending.length ? 'available' : 'up-to-date';
  return {
    app: 'rkeychat-desktop', appName: 'rKeyChat', running: RUNNING, platform: { os: 'mac', arch: 'arm64' }, status,
    latest: versions[0] ?? null, available: pending.length > 0, behind: pending.length, progress: updJob.state === 'downloading' ? updJob.progress ?? null : null,
    error: updJob.state === 'error' ? updJob.error ?? 'failed' : null, canInstall: true, versions, pending, job: { ...updJob },
    channel: { name: 'rKeyChat', publisher: MOCK_PUBLISHER, link: 'pearcore://mock-channel', folder: null, connected: true, isDefault: true, publisherIsMe: false, peers: 1 },
    rejected: 0, checkedAt: now, refused: null, phone: DEVICES[0].canHost === false,
  };
}
async function mockDownload(id?: string | null): Promise<UpdatesState> {
  const rel = id ? mockVersions.find((v) => v.id === id) : updatesState().pending[0];
  if (!rel) throw new ApiError(400, 'no newer version for this computer');
  if (updJob.state === 'ready' && updJob.id === rel.id) return updatesState();
  updJob = { state: 'downloading', id: rel.id, version: rel.version, progress: 0 };
  emit('updates', updatesState());
  for (let i = 1; i <= 6; i++) {
    await sleep(180);
    updJob = { ...updJob, progress: i / 6 };
    emit('updates', updatesState());
  }
  updJob = { state: 'ready', id: rel.id, version: rel.version, path: `/tmp/${rel.file}`, progress: 1 };
  emit('updates', updatesState());
  return updatesState();
}

const PRESETS: Record<string, ProviderPreset> = {
  ppq: { label: 'PPQ', baseUrl: 'https://api.ppq.ai', key: 'required', keyUrl: 'https://ppq.ai/api-docs', blurb: 'Pay per question, no account needed. Paste a PPQ API key.' },
  openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api', key: 'required', keyUrl: 'https://openrouter.ai/settings/keys', blurb: 'One key for many models. Paste an OpenRouter API key.' },
  llamacpp: { label: 'llama.cpp', baseUrl: 'http://127.0.0.1:8080', key: 'none', blurb: 'A model running on this computer with llama-server. No key.' },
};
// `?setup=fresh` (or localStorage rkc.mock.setup=fresh): a computer that was just installed, nothing connected yet
const FRESH = typeof window !== 'undefined' && (new URLSearchParams(window.location.search).get('setup') === 'fresh' || localStorage.getItem('rkc.mock.setup') === 'fresh');
const mockProviders: Provider[] = FRESH ? [] : [{ name: 'ppq', baseUrl: 'https://api.ppq.ai', hasToken: true, preset: 'ppq', label: 'PPQ', ready: true }];
let claudeStatus: ClaudeStatus = FRESH ? { loggedIn: false, method: 'none' } : { loggedIn: true, method: 'claude.ai', email: 'guy@example.com', plan: 'max' };
let claudeLogin: ClaudeLoginState = { running: false, url: null, waitingForCode: false, error: null, done: false };
const setup = { agent: FRESH ? null : ('claude' as string | null), done: !FRESH };
function setupInfo(): SetupInfo {
  const agent = setup.agent;
  const connected = agent && agent !== 'claude' ? mockProviders.some((p) => p.name === agent && p.ready) : claudeStatus.loggedIn;
  return { name: ME, device: DEVICE, canHost: DEVICES[0].canHost !== false, claude: { ...claudeStatus }, providers: mockProviders.map((p) => ({ ...p })), presets: PRESETS, agent, connected: !!connected, workspace, workspaceSet: !FRESH, done: setup.done };
}
