/**
 * Typed client for every route in docs/projects-api.md. With VITE_MOCK=1 the same interface is
 * served from an in-memory fixture (mock/), so the app runs without a daemon.
 */
import type { Grant, GrantsInfo, AgentInfo, AutoLimit, Charter, ClaudeLoginState, ClaudeStatus, DebugNoteInfo, DebugSpaceInfo, DebugSyncInfo, OpenAsk, Conversation, Device, FileEntry, LogPage, LoginAsk, PendingProject, PendingRequest, Person, Provider, ProviderPreset, Rec, ReleaseInfo, RoomSummary, SearchHit, Seat, SeatChange, SetupInfo, StateResponse, UpdatesState } from './types';

export interface Api {
  state(room?: string | null, conv?: string | null): Promise<StateResponse>;
  rooms(): Promise<RoomSummary[]>;
  log(q: { room: string; conv?: string; limit?: number; before?: string; after?: string; around?: string }): Promise<LogPage>;
  convs(room: string): Promise<Conversation[]>;
  createConv(body: { room: string; title: string; runtime?: string | null; text?: string }): Promise<Conversation>;
  renameConv(body: { room: string; conv: string; title: string }): Promise<Conversation>;
  archiveConv(body: { room: string; conv: string; archived: boolean }): Promise<Conversation>;
  setConvRuntime(body: { room: string; conv: string; runtime: string | null }): Promise<Conversation>;
  send(body: { room: string; as: string; text: string; conv: string; re?: string[] }): Promise<Rec>;
  search(q: { q: string; room?: string; conv?: string; limit?: number }): Promise<{ results: SearchHit[] }>;
  activity(q: { room: string; conv?: string }): Promise<unknown>;
  /** `home` (a device ref or name) elsewhere → the daemon asks that device and answers `{ pending: true, … }`. */
  createProject(body: { folder?: string; name?: string; home?: string; prompt?: string; org?: string; agent?: string; via?: 'acp' | 'cli' }): Promise<{ room: RoomSummary; seat: Seat | string } | PendingProject>;
  /** The projects this device asked other devices for that no room has answered yet (the "waiting on …" rows). */
  pendingProjects(): Promise<PendingRequest[]>;
  renameRoom(body: { room: string; name: string }): Promise<unknown>;
  setRoomOrg(body: { room: string; org: string | null }): Promise<RoomSummary>;
  /** Takes the room off this device; the folder on disk stays. */
  removeRoom(body: { room: string }): Promise<{ removed: boolean; topic: string; seats?: string[]; folder?: string | null }>;
  files(room: string): Promise<FileEntry[]>;
  fetchFile(body: { room: string; hash: string }): Promise<FileEntry & { path: string }>;
  invite(room: string): Promise<{ invite: string; room: string }>;
  people(): Promise<{ local: Person[]; known: Person[] }>;
  agents(): Promise<AgentInfo[]>;
  loginAsks(): Promise<{ asking: LoginAsk[] }>;
  /** Agents waiting on a person for a permission (every room). */
  asks(): Promise<{ asks: OpenAsk[] }>;
  /** Answer one: a signed control only the owner's own devices may write. */
  answerAsk(body: { room: string; ask: string; choice: string }): Promise<Rec>;
  /** What a project's agents may read and run without asking, and the owner's changes to it (signed grants). */
  grants(room: string): Promise<GrantsInfo>;
  grant(body: { room: string; folder?: string; rule?: string; revoke?: boolean }): Promise<Rec & { grants: Grant[] }>;
  loginGrant(topic: string): Promise<unknown>;
  loginDeny(topic: string): Promise<unknown>;
  debugNotes(): Promise<DebugSpaceInfo & { notes: DebugNoteInfo[] }>;
  /** Who is on the notes space and which reader has fetched which note. */
  debugSync(): Promise<DebugSyncInfo>;
  /** `audio` is base64 of the recording (≤ 8 MB), or null for a steps-only note. */
  debugSaveNote(body: { id: string; audio: string | null; audioType: string | null; trace: unknown[]; meta: Record<string, unknown> }): Promise<{ id: string; dir?: string; files?: string[]; shared?: boolean; sharelink?: string | null }>;
  /** Posts a saved note's files into a room's conversation. */
  debugShare(body: { id: string; room: string }): Promise<unknown>;
  /** Follow another device's notes space by its link: its notes are fetched whenever that device is heard from. */
  debugFollow(body: { link: string }): Promise<{ host: string; following: string[] }>;
  debugUnfollow(body: { host: string }): Promise<{ host: string; following: string[] }>;
  devices(): Promise<Device[]>;
  workspace(): Promise<{ workspace: string }>;
  setWorkspace(body: { workspace: string }): Promise<{ workspace: string }>;
  bindFolder(body: { room: string; folder: string }): Promise<RoomSummary>;
  react(body: { room: string; as?: string; target: string; emoji: string; on?: boolean }): Promise<Rec>;
  charter(body: { room: string } & Charter): Promise<unknown>;
  setAgentVia(body: { name: string; via: 'acp' | 'cli' }): Promise<unknown>;
  /**
   * A seat's settings from the bot's profile: a signed `seat` control only the owner's own devices may write; the
   * device hosting the seat applies it and writes back how the seat now runs (the snapshot's seat row follows).
   */
  seatControl(body: { room: string; agent: string; seat: SeatChange }): Promise<Rec>;
  /** The room's cap on Auto: a signed `auto` control (owner's devices only); both fields empty lifts it. */
  autoCap(body: { room: string; auto: AutoLimit }): Promise<Rec>;
  /** The round budget: `rounds` (standing, 0 = default), `extend` (this exchange), `until` (hours), `unlimited`, `reset`. */
  rounds(body: { room: string; action: 'rounds' | 'extend' | 'until' | 'unlimited' | 'reset'; n?: number; hours?: number }): Promise<Rec>;
  /** An agent's posts per human message (0 = no limit). */
  agentLimit(body: { room: string; agent: string; n: number }): Promise<Rec>;
  providers(): Promise<{ providers: Provider[]; presets?: Record<string, ProviderPreset> }>;
  /** Add or change a provider; the token is written, never read back. Without `token`, the held one is kept. */
  setProvider(body: { name: string; baseUrl?: string; token?: string }): Promise<Provider>;
  removeProvider(body: { name: string }): Promise<{ removed: string }>;
  /** First-run setup: what this device has and chose (docs/first-run.md). */
  setup(): Promise<SetupInfo>;
  /** Save a choice: which agent new seats run on ('claude', a provider, null), and whether the flow is finished. */
  saveSetup(body: { agent?: string | null; done?: boolean }): Promise<SetupInfo>;
  /** The Claude login this computer holds, and a login in progress if one is. */
  claude(): Promise<ClaudeStatus & { login: ClaudeLoginState }>;
  /** Start a Claude login: the browser opens; the state is pushed as `claude` events. */
  claudeLogin(): Promise<ClaudeLoginState>;
  /** The code the browser showed, when the login waits for one. */
  claudeLoginCode(body: { code: string }): Promise<ClaudeLoginState>;
  claudeLoginCancel(): Promise<ClaudeLoginState>;
  claudeLogout(): Promise<ClaudeStatus>;
  /** In-app updates (docs/updates.md): where the channel stands, the versions on it, this copy's version. */
  updates(): Promise<UpdatesState>;
  /** Read the channel again. */
  updatesCheck(): Promise<UpdatesState>;
  /** Fetch an installer (the newest pending one without `id`); progress comes as `updates` events. */
  updatesDownload(body: { id?: string | null }): Promise<UpdatesState>;
  /** Download if needed, then the desktop app swaps itself and relaunches. */
  updatesInstall(body: { id?: string | null }): Promise<UpdatesState>;
  /** Where updates come from: a Space link + publisher key, a local folder, or back to the default. */
  updatesChannel(body: { link?: string | null; publisher?: string | null; folder?: string | null; reset?: boolean }): Promise<UpdatesState>;
  /** One release in full, signature included (the release window). */
  updatesRelease(id: string): Promise<ReleaseInfo>;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const qs = (q: Record<string, string | number | null | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!res.ok) {
    const err = data && typeof data === 'object' && 'error' in data ? String((data as { error: unknown }).error) : '';
    throw new ApiError(res.status, err || `${res.status} ${res.statusText}`);
  }
  return data as T;
}

const get = <T>(path: string, q: Record<string, string | number | null | undefined> = {}) => request<T>('GET', `/api/${path}${qs(q)}`);
const post = <T>(path: string, body: unknown) => request<T>('POST', `/api/${path}`, body);

export const httpApi: Api = {
  state: (room, conv) => get('state', { room, conv }),
  rooms: () => get('rooms'),
  log: (q) => get('log', q),
  convs: (room) => get('convs', { room }),
  createConv: (b) => post('convs', b),
  renameConv: (b) => post('convs/rename', b),
  archiveConv: (b) => post('convs/archive', b),
  setConvRuntime: (b) => post('convs/runtime', b),
  send: (b) => post('send', b),
  search: (q) => get('search', q),
  activity: (q) => get('activity', q),
  createProject: (b) => post('projects', b),
  pendingProjects: () => get('projects/pending'),
  bindFolder: (b) => post('rooms/folder', b),
  devices: () => get('devices'),
  workspace: () => get('workspace'),
  setWorkspace: (b) => post('workspace', b),
  react: (b) => post('react', b),
  charter: ({ room, text, order, agents }) => post('control', { room, action: 'charter', text, order, agents }),
  renameRoom: ({ room, name }) => post('control', { room, action: 'rename', name }),
  setRoomOrg: (b) => post('rooms/org', b),
  removeRoom: (b) => post('rooms/remove', b),
  files: (room) => get('files', { room }),
  fetchFile: (b) => post('fetch', b),
  invite: (room) => get('invite', { room }),
  people: () => get('people'),
  agents: () => get('agents'),
  loginAsks: () => get('login/pending'),
  asks: () => get('asks'),
  answerAsk: (b) => post('asks/answer', b),
  grants: (room) => get('grants', { room }),
  grant: (b) => post('grants', b),
  loginGrant: (topic) => post('login/grant', { topic }),
  loginDeny: (topic) => post('login/deny', { topic }),
  debugNotes: () => get('debug/notes'),
  debugSync: () => get('debug/sync'),
  debugSaveNote: (b) => post('debug/note', b),
  debugShare: (b) => post('debug/share', b),
  debugFollow: (b) => post('debug/follow', b),
  debugUnfollow: (b) => post('debug/unfollow', b),
  setAgentVia: (b) => post('agents/via', b),
  seatControl: ({ room, agent, seat }) => post('control', { room, action: 'seat', agent, seat }),
  autoCap: ({ room, auto }) => post('control', { room, action: 'auto', auto }),
  rounds: (b) => post('control', b),
  agentLimit: ({ room, agent, n }) => post('control', { room, action: 'limit', agent, n }),
  providers: () => get('providers'),
  setProvider: (b) => post('providers', b),
  removeProvider: (b) => post('providers/remove', b),
  setup: () => get('setup'),
  saveSetup: (b) => post('setup', b),
  claude: () => get('claude'),
  claudeLogin: () => post('claude/login', {}),
  claudeLoginCode: (b) => post('claude/login/code', b),
  claudeLoginCancel: () => post('claude/login/cancel', {}),
  claudeLogout: () => post('claude/logout', {}),
  updates: () => get('updates'),
  updatesCheck: () => post('updates/check', {}),
  updatesDownload: (b) => post('updates/download', b),
  updatesInstall: (b) => post('updates/install', b),
  updatesChannel: (b) => post('updates/channel', b),
  updatesRelease: (id) => get('updates/release', { id }),
};

export const MOCK = import.meta.env?.VITE_MOCK === '1';

let api: Api = httpApi;
/** Swap the implementation (the mock does this at startup; tests may too). */
export function setApi(next: Api) {
  api = next;
}
export function getApi(): Api {
  return api;
}
